import fs from 'fs-extra';
import {execSync} from 'node:child_process';
import crypto from 'node:crypto';
import {EventEmitter} from 'node:events';
import path from 'node:path';

import type {WorkspacePackageJson} from '../types/workspace.js';

import SfpmPackage, {SfpmDataPackage, SfpmMetadataPackage} from '../package/sfpm-package.js';
import {ArtifactError} from '../types/errors.js';
import {Logger} from '../types/logger.js';
import {toVersionFormat} from '../utils/version-utils.js';
import {ArtifactRepository} from './artifact-repository.js';
import {toNpmPackageJson} from './npm-package-adapter.js';

/**
 * Interface for providing changelogs.
 * Can be implemented later with Git or other providers.
 */
export interface ChangelogProvider {
  generateChangelog(pkg: SfpmPackage, projectDirectory: string): Promise<any>;
}

/**
 * Stub implementation of the ChangelogProvider.
 */
class StubChangelogProvider implements ChangelogProvider {
  async generateChangelog(_pkg: SfpmPackage, _projectDirectory: string): Promise<any> {
    return {
      message: 'Changelog generation is currently disabled.',
      timestamp: Date.now(),
    };
  }
}

/**
 * Options for artifact assembly
 */
export interface ArtifactAssemblerOptions {
  /** Additional keywords to append at build time */
  additionalKeywords?: string[];
  /** Changelog provider for generating changelog.json */
  changelogProvider?: ChangelogProvider;
  /** Pre-classified managed dependencies (alias -> packageVersionId 04t...) */
  managedDependencies?: Record<string, string>;
}

/**
 * @description Assembles artifacts using npm pack for npm-native packaging.
 *
 * The new assembly flow:
 * 1. Prepare staging directory with source, sfdx-project.json, scripts, etc.
 * 2. Generate package.json with sfpm metadata
 * 3. Generate changelog.json
 * 4. Run npm pack to create tarball
 * 5. Move tarball to artifacts/<package>/<version>/artifact.tgz
 * 6. Update manifest and symlink
 * 7. Clean up staging directory
 */
export default class ArtifactAssembler extends EventEmitter {
  private changelogProvider: ChangelogProvider;
  private options: ArtifactAssemblerOptions;
  private packageVersionNumber: string;
  private repository: ArtifactRepository;
  private versionDirectory: string;

  constructor(
    private sfpmPackage: SfpmPackage,
    private projectDirectory: string,
    options: ArtifactAssemblerOptions,
    private logger?: Logger,
  ) {
    super();
    this.options = options;
    this.packageVersionNumber = toVersionFormat(sfpmPackage.version || '0.0.0.1', 'semver');

    // Create repository for artifact operations
    this.repository = new ArtifactRepository(projectDirectory, logger);

    // artifacts/<package_name>/<version>
    this.versionDirectory = this.repository.getVersionPath(sfpmPackage.packageName, this.packageVersionNumber);

    this.changelogProvider = options.changelogProvider || new StubChangelogProvider();
  }

  /**
   * @description Orchestrates the artifact assembly process.
   * @returns {Promise<string>} The path to the generated artifact.tgz.
   */
  public async assemble(): Promise<string> {
    const startTime = Date.now();
    try {
      this.emitStart();

      // 1. Calculate sourceHash from current package state
      const currentSourceHash = await this.calculateSourceHash();

      // 2. Prepare staging: rename the staging directory to `package/` inside
      //    a workspace directory so the tarball entries get the npm-standard
      //    `package/` prefix without any path substitution flags.
      const {packageDir, workspaceDir} = await this.prepareStagingDirectory();

      // 3. Generate package.json with sfpm metadata
      await this.generatePackageJson(packageDir);

      // 4. Generate changelog
      await this.generateChangelog(packageDir);

      // 5. Create tarball from the workspace directory
      const tarballName = await this.createTarball(workspaceDir);

      // 6. Move tarball to version directory
      const artifactPath = await this.moveTarball(workspaceDir, tarballName);

      // 7. Calculate artifact hash and finalize
      const artifactHash = await this.finalizeArtifact(artifactPath, currentSourceHash);

      // 8. Cleanup workspace directory (includes package/ and the tarball)
      await fs.remove(workspaceDir);

      this.emitComplete(artifactPath, currentSourceHash, artifactHash, startTime);
      return artifactPath;
    } catch (error: any) {
      this.emitError(error);
      throw new ArtifactError(this.sfpmPackage.packageName, 'assembly', 'Failed to assemble artifact', {
        cause: error instanceof Error ? error : new Error(String(error)),
        version: this.packageVersionNumber,
      });
    }
  }

  /**
   * Build a tarball filename matching npm convention: `<scope>-<name>-<version>.tgz`
   * Scoped packages replace `@` and `/` with hyphens.
   */
  private buildTarballName(name: string, version: string): string {
    // @myorg/my-package -> myorg-my-package
    const normalized = name.replace(/^@/, '').replaceAll('/', '-');
    return `${normalized}-${version}.tgz`;
  }

  /**
   * Get or calculate the source hash for the package.
   * Prefers the package's existing sourceHash if already set.
   * For metadata packages, calculates and sets the hash on the package.
   */
  private async calculateSourceHash(): Promise<string> {
    // If sourceHash is already set on the package, use it
    if (this.sfpmPackage.sourceHash) {
      this.logger?.debug(`Using existing source hash: ${this.sfpmPackage.sourceHash}`);
      return this.sfpmPackage.sourceHash;
    }

    let hash: string;
    if (this.sfpmPackage instanceof SfpmMetadataPackage) {
      // Calculate and set the hash on the package
      hash = await this.sfpmPackage.calculateSourceHash();
    } else if (this.sfpmPackage instanceof SfpmDataPackage) {
      // Data packages: deterministic hash of all files in the data directory
      hash = await this.sfpmPackage.calculateSourceHash();
    } else {
      // For non-metadata packages, use a simple timestamp-based hash
      hash = crypto.createHash('sha256').update(Date.now().toString()).digest('hex');
      this.sfpmPackage.sourceHash = hash;
    }

    this.logger?.debug(`Calculated source hash: ${hash}`);
    return hash;
  }

  /**
   * Create an npm-compatible tarball from the workspace directory.
   *
   * Because the content lives under `workspace/package/`, the tar entries
   * naturally get the `package/` prefix that npm expects — no path
   * substitution flags required.
   *
   * @returns The name of the generated tarball file inside `workspaceDir`.
   */
  private async createTarball(workspaceDir: string): Promise<string> {
    this.logger?.debug(`Creating tarball from ${workspaceDir}`);

    try {
      // Read the generated package.json to build the canonical tarball name
      const packageJson = await fs.readJson(path.join(workspaceDir, 'package', 'package.json'));
      const tarballName = this.buildTarballName(packageJson.name, packageJson.version);

      execSync(
        `tar -czf "${tarballName}" package`,
        {
          cwd: workspaceDir,
          encoding: 'utf8',
          timeout: 60_000,
        },
      );

      this.logger?.debug(`Tarball created: ${tarballName}`);

      this.emit('assembly:pack', {
        packageName: this.sfpmPackage.packageName,
        tarballName,
        timestamp: new Date(),
      });

      return tarballName;
    } catch (error) {
      throw new ArtifactError(this.sfpmPackage.packageName, 'pack', 'Failed to create tarball', {
        cause: error instanceof Error ? error : new Error(String(error)),
        context: {workspaceDir},
        version: this.packageVersionNumber,
      });
    }
  }

  private emitComplete(artifactPath: string, sourceHash: string, artifactHash: string, startTime: number): void {
    this.logger?.info(`Artifact successfully stored at ${artifactPath}`);
    this.emit('assembly:complete', {
      artifactHash,
      artifactPath,
      duration: Date.now() - startTime,
      packageName: this.sfpmPackage.packageName,
      sourceHash,
      timestamp: new Date(),
      version: this.packageVersionNumber,
    });
  }

  private emitError(error: any): void {
    this.logger?.error(`Failed to assemble artifact: ${error.message}`);
    this.emit('assembly:error', {
      error: error instanceof Error ? error : new Error(String(error)),
      packageName: this.sfpmPackage.packageName,
      timestamp: new Date(),
      version: this.packageVersionNumber,
    });
  }

  private emitStart(): void {
    this.logger?.info(`Assembling artifact for ${this.sfpmPackage.packageName}@${this.packageVersionNumber}`);
    this.emit('assembly:start', {
      packageName: this.sfpmPackage.packageName,
      timestamp: new Date(),
      version: this.packageVersionNumber,
    });
  }

  /**
   * Calculate artifact hash and update manifest.
   */
  private async finalizeArtifact(artifactPath: string, sourceHash: string): Promise<string> {
    const artifactHash = await this.repository.calculateFileHash(artifactPath);
    this.logger?.debug(`Artifact hash: ${artifactHash}`);

    await this.repository.finalizeArtifact(this.sfpmPackage.packageName, this.packageVersionNumber, {
      artifactHash,
      commit: this.sfpmPackage.commitId,
      generatedAt: Date.now(),
      path: this.repository.getRelativeArtifactPath(this.sfpmPackage.packageName, this.packageVersionNumber),
      sourceHash,
    });

    return artifactHash;
  }

  // =========================================================================
  // Event Emission Helpers
  // =========================================================================

  /**
   * Generate changelog.json in the staging directory.
   */
  private async generateChangelog(stagingDir: string): Promise<void> {
    const changelog = await this.changelogProvider.generateChangelog(this.sfpmPackage, this.projectDirectory);
    const changelogPath = path.join(stagingDir, 'changelog.json');
    await fs.writeJson(changelogPath, changelog, {spaces: 4});
  }

  /**
   * Generate package.json in the staging directory.
   *
   * Reads the workspace package.json (static config: name, version, author,
   * license, dependencies, etc.) and overlays build-time properties via the
   * npm-package-adapter (sfpm metadata, files list, repository, resolved version).
   */
  private async generatePackageJson(stagingDir: string): Promise<void> {
    const packageJsonPath = path.join(stagingDir, 'package.json');

    // Read the workspace package.json as the base for the artifact
    const workspacePkgJson = await this.readWorkspacePackageJson();

    const generated = await toNpmPackageJson(
      workspacePkgJson,
      this.sfpmPackage,
      this.packageVersionNumber,
      this.options,
    );

    await fs.writeJson(packageJsonPath, generated, {spaces: 2});
    this.logger?.debug(`Generated package.json at ${packageJsonPath}`);
  }

  /**
   * Move the tarball from the workspace to the version directory.
   */
  private async moveTarball(workspaceDir: string, tarballName: string): Promise<string> {
    const sourcePath = path.join(workspaceDir, tarballName);
    const targetPath = this.repository.getArtifactPath(this.sfpmPackage.packageName, this.packageVersionNumber);

    // Ensure version directory exists
    await fs.ensureDir(path.dirname(targetPath));

    // Move the tarball
    await fs.move(sourcePath, targetPath, {overwrite: true});
    this.logger?.debug(`Moved tarball to ${targetPath}`);

    return targetPath;
  }

  /**
   * Prepare the staging layout for tarball creation.
   *
   * The PackageAssembler stages content directly into `<buildName>/package/`,
   * so the parent directory is already a ready-made workspace for
   * `tar -czf … package`.
   *
   * @returns `workspaceDir` — the parent that contains `package/`
   *          `packageDir`   — the `package/` directory with the actual content
   */
  private async prepareStagingDirectory(): Promise<{packageDir: string; workspaceDir: string}> {
    if (!this.sfpmPackage.workingDirectory) {
      throw new ArtifactError(
        this.sfpmPackage.packageName,
        'assembly',
        'No staging directory available - package must be staged before assembly',
        {version: this.packageVersionNumber},
      );
    }

    const packageDir = this.sfpmPackage.workingDirectory;
    const workspaceDir = path.dirname(packageDir);
    this.logger?.debug(`Using staging directory: ${packageDir}`);

    // Cleanup noise from staging directory
    const noise = ['.sfpm', '.sfdx', 'node_modules'];
    for (const dir of noise) {
      const noiseDir = path.join(packageDir, dir);
      // eslint-disable-next-line no-await-in-loop
      if (await fs.pathExists(noiseDir)) {
        // eslint-disable-next-line no-await-in-loop
        await fs.remove(noiseDir);
      }
    }

    return {packageDir, workspaceDir};
  }

  /**
   * Locate and read the workspace package.json for this package.
   *
   * Walks up from the SF source path (packageDefinition.path) to find the
   * nearest package.json with an `sfpm` property. This handles both cases:
   * - sfpm.path is set (e.g., "force-app") → package.json is one+ levels up
   * - sfpm.path is "." or unset → package.json is at the source path root
   */
  private async readWorkspacePackageJson(): Promise<WorkspacePackageJson> {
    const sourcePath = this.sfpmPackage.packageDefinition?.path;
    if (!sourcePath) {
      throw new ArtifactError(
        this.sfpmPackage.packageName,
        'assembly',
        'Package definition path is not set — cannot locate workspace package.json',
        {version: this.packageVersionNumber},
      );
    }

    const parts = sourcePath.split('/');
    for (let i = parts.length; i > 0; i--) {
      const candidatePath = path.join(this.projectDirectory, ...parts.slice(0, i), 'package.json');
      try {
        // eslint-disable-next-line no-await-in-loop
        if (await fs.pathExists(candidatePath)) {
          // eslint-disable-next-line no-await-in-loop
          const pkgJson = await fs.readJson(candidatePath);
          if (pkgJson.sfpm?.packageType) {
            this.logger?.debug(`Using workspace package.json from ${candidatePath}`);
            return pkgJson as WorkspacePackageJson;
          }
        }
      } catch {
        // Continue searching
      }
    }

    throw new ArtifactError(
      this.sfpmPackage.packageName,
      'assembly',
      `No workspace package.json found for source path "${sourcePath}"`,
      {version: this.packageVersionNumber},
    );
  }
}
