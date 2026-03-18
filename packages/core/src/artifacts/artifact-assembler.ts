import fs from 'fs-extra';
import {execSync} from 'node:child_process';
import crypto from 'node:crypto';
import {EventEmitter} from 'node:events';
import path from 'node:path';

import SfpmPackage, {SfpmDataPackage, SfpmMetadataPackage} from '../package/sfpm-package.js';
import {toVersionFormat} from '../utils/version-utils.js';
import {ArtifactError} from '../types/errors.js';
import {Logger} from '../types/logger.js';
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
  /** Additional keywords for package.json */
  additionalKeywords?: string[];
  /** Author string for package.json */
  author?: string;
  /** Changelog provider for generating changelog.json */
  changelogProvider?: ChangelogProvider;
  /** Homepage URL (e.g., AppExchange listing, project docs) */
  homepage?: string;
  /** License identifier for package.json */
  license?: string;
  /** Pre-classified managed dependencies (alias -> packageVersionId 04t...) */
  managedDependencies?: Record<string, string>;
  /** npm scope for the package (e.g., "@myorg") - required */
  npmScope: string;
  /** Suppress npm pack notice output (default: true) */
  quietPack?: boolean;
  /** Pre-classified versioned dependencies (scoped npm name -> semver range) */
  versionedDependencies?: Record<string, string>;
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
   * @description Orchestrates the artifact assembly process using npm pack.
   * @returns {Promise<string>} The path to the generated artifact.tgz.
   */
  public async assemble(): Promise<string> {
    const startTime = Date.now();
    try {
      this.emitStart();

      // 1. Calculate sourceHash from current package state
      const currentSourceHash = await this.calculateSourceHash();

      // 2. Prepare staging directory with source files
      const stagingDir = await this.prepareStagingDirectory();

      // 3. Generate package.json with sfpm metadata
      await this.generatePackageJson(stagingDir);

      // 4. Generate changelog
      await this.generateChangelog(stagingDir);

      // 5. Run npm pack in staging directory
      const tarballName = await this.runNpmPack(stagingDir);

      // 6. Move tarball to version directory
      const artifactPath = await this.moveTarball(stagingDir, tarballName);

      // 7. Calculate artifact hash and finalize
      const artifactHash = await this.finalizeArtifact(artifactPath, currentSourceHash);

      // 8. Cleanup staging directory
      await fs.remove(stagingDir);

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
   * Delegates to the npm-package-adapter for package.json construction.
   */
  private async generatePackageJson(stagingDir: string): Promise<void> {
    const packageJson = await toNpmPackageJson(
      this.sfpmPackage,
      this.packageVersionNumber,
      this.options,
    );

    const packageJsonPath = path.join(stagingDir, 'package.json');
    await fs.writeJson(packageJsonPath, packageJson, {spaces: 2});
    this.logger?.debug(`Generated package.json at ${packageJsonPath}`);
  }

  // =========================================================================
  // Event Emission Helpers
  // =========================================================================

  /**
   * Move the tarball from staging to the version directory.
   */
  private async moveTarball(stagingDir: string, tarballName: string): Promise<string> {
    const sourcePath = path.join(stagingDir, tarballName);
    const targetPath = this.repository.getArtifactPath(this.sfpmPackage.packageName, this.packageVersionNumber);

    // Ensure version directory exists
    await fs.ensureDir(path.dirname(targetPath));

    // Move the tarball
    await fs.move(sourcePath, targetPath, {overwrite: true});
    this.logger?.debug(`Moved tarball to ${targetPath}`);

    return targetPath;
  }

  /**
   * Prepare staging directory with source files.
   * Uses the package's staging directory from PackageAssembler.
   */
  private async prepareStagingDirectory(): Promise<string> {
    if (this.sfpmPackage.stagingDirectory) {
      this.logger?.debug(`Using staging directory: ${this.sfpmPackage.stagingDirectory}`);

      // Cleanup noise from staging directory
      const noise = ['.sfpm', '.sfdx', 'node_modules'];
      for (const dir of noise) {
        const noiseDir = path.join(this.sfpmPackage.stagingDirectory, dir);
        // eslint-disable-next-line no-await-in-loop
        if (await fs.pathExists(noiseDir)) {
          // eslint-disable-next-line no-await-in-loop
          await fs.remove(noiseDir);
        }
      }

      return this.sfpmPackage.stagingDirectory;
    }

    throw new ArtifactError(
      this.sfpmPackage.packageName,
      'assembly',
      'No staging directory available - package must be staged before assembly',
      {version: this.packageVersionNumber},
    );
  }

  /**
   * Run npm pack in the staging directory.
   * @returns The name of the generated tarball file.
   */
  private async runNpmPack(stagingDir: string): Promise<string> {
    this.logger?.debug(`Running npm pack in ${stagingDir}`);

    try {
      // npm pack outputs the filename of the created tarball
      // --quiet suppresses the "npm notice" lines (tarball contents, details)
      const quiet = this.options.quietPack !== false;
      const output = execSync(`npm pack${quiet ? ' --quiet' : ''}`, {
        cwd: stagingDir,
        encoding: 'utf8',
        timeout: 60_000,
      }).trim();

      // The output is the tarball filename (e.g., "myorg-my-package-1.0.0-1.tgz")
      const tarballName = output.split('\n').pop()?.trim();

      if (!tarballName || !tarballName.endsWith('.tgz')) {
        throw new Error(`Unexpected npm pack output: ${output}`);
      }

      this.logger?.debug(`npm pack created: ${tarballName}`);

      this.emit('assembly:pack', {
        packageName: this.sfpmPackage.packageName,
        tarballName,
        timestamp: new Date(),
      });

      return tarballName;
    } catch (error) {
      throw new ArtifactError(this.sfpmPackage.packageName, 'pack', 'npm pack failed', {
        cause: error instanceof Error ? error : new Error(String(error)),
        context: {stagingDir},
        version: this.packageVersionNumber,
      });
    }
  }
}
