import fs from 'fs-extra';
import crypto from 'node:crypto';
import path from 'node:path';

import type {WorkspacePackageJson} from '../project/providers/types/workspace.js';

import {GitService} from '../git/git-service.js';
import Git from '../git/git.js';
import SfpmPackage, {SfpmDataPackage, SfpmMetadataPackage} from '../package/sfpm-package.js';
import {ArtifactError} from '../types/errors.js';
import {Logger} from '../types/logger.js';
import {DirectoryHasher} from '../utils/directory-hasher.js';
import {SourceHasher} from '../utils/source-hasher.js';
import {toVersionFormat} from '../utils/version-utils.js';
import {toNpmPackageJson} from './npm-package-adapter.js';

/**
 * Write-only contract for artifact assembly events.
 * Satisfied by {@link ScopedBuildSink} — the assembler doesn't need the full bus.
 */
export interface ArtifactEventSink {
  artifactComplete(payload: {artifactHash: string; artifactPath: string; duration: number; sourceHash: string; version: string}): void;
  artifactError(payload: {error: Error; version: string}): void;
  artifactPack(payload: {tarballName: string}): void;
  artifactStart(payload: {version: string}): void;
}

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
 * @description Assembles artifact metadata for a built package.
 *
 * The assembly flow (post-build):
 * 1. Calculate source hash from staged package content
 * 2. Generate package.json with sfpm metadata (includes sourceHash, version, etc.)
 * 3. Generate changelog.json
 *
 * All build metadata lives in `dist/package.json` under the `sfpm` field —
 * no sidecar manifest file. The dist directory is flat, publishable, and
 * directly cacheable by Turbo.
 */
export default class ArtifactAssembler {
  private changelogProvider: ChangelogProvider;
  private options: ArtifactAssemblerOptions;
  private packageVersionNumber: string;
  private sink?: ArtifactEventSink;

  constructor(
    private sfpmPackage: SfpmPackage,
    private projectDirectory: string,
    options: ArtifactAssemblerOptions,
    private logger?: Logger,
    sink?: ArtifactEventSink,
  ) {
    this.options = options;
    this.sink = sink;
    this.packageVersionNumber = toVersionFormat(sfpmPackage.version || '0.0.0.1', 'semver');

    this.changelogProvider = options.changelogProvider || new StubChangelogProvider();
  }

  /**
   * @description Orchestrates the artifact assembly process.
   * Generates metadata files (package.json, changelog) in the
   * already-staged `dist/` directory.
   */
  public async assemble(): Promise<string> {
    const startTime = Date.now();
    try {
      this.emitStart();

      // 1. Calculate sourceHash from current package state
      const currentSourceHash = await this.calculateSourceHash();

      // 2. Validate staging directory exists
      const packageDir = this.prepareStagingDirectory();

      // 3. Generate package.json with sfpm metadata and source context
      await this.generatePackageJson(packageDir, currentSourceHash);

      // 4. Generate changelog
      await this.generateChangelog(packageDir);

      this.emitComplete(packageDir, currentSourceHash, startTime);
      return packageDir;
    } catch (error: any) {
      this.emitError(error);
      throw new ArtifactError(this.sfpmPackage.name, 'assembly', 'Failed to assemble artifact', {
        cause: error instanceof Error ? error : new Error(String(error)),
        version: this.packageVersionNumber,
      });
    }
  }

  /**
   * Calculate the source hash for the package.
   * Uses the appropriate hasher based on package type.
   */
  private async calculateSourceHash(): Promise<string> {
    let hash: string;
    if (this.sfpmPackage instanceof SfpmMetadataPackage) {
      hash = await SourceHasher.calculate(this.sfpmPackage);
    } else if (this.sfpmPackage instanceof SfpmDataPackage) {
      hash = await DirectoryHasher.calculate(this.sfpmPackage.dataDirectory);
    } else {
      hash = crypto.createHash('sha256').update(Date.now().toString()).digest('hex');
    }

    this.logger?.debug(`Calculated source hash: ${hash}`);
    return hash;
  }

  private emitComplete(packageDir: string, sourceHash: string, startTime: number): void {
    this.logger?.info(`Artifact assembled at ${packageDir}`);
    this.sink?.artifactComplete({
      artifactHash: '',
      artifactPath: packageDir,
      duration: Date.now() - startTime,
      sourceHash,
      version: this.packageVersionNumber,
    });
  }

  private emitError(error: any): void {
    this.logger?.error(`Failed to assemble artifact: ${error.message}`);
    this.sink?.artifactError({
      error: error instanceof Error ? error : new Error(String(error)),
      version: this.packageVersionNumber,
    });
  }

  private emitStart(): void {
    this.logger?.info(`Assembling artifact for ${this.sfpmPackage.name}@${this.packageVersionNumber}`);
    this.sink?.artifactStart({
      version: this.packageVersionNumber,
    });
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
  private async generatePackageJson(stagingDir: string, sourceHash: string): Promise<void> {
    const packageJsonPath = path.join(stagingDir, 'package.json');

    // Read the workspace package.json as the base for the artifact
    const workspacePkgJson = await this.readWorkspacePackageJson();

    // Auto-resolve git context for repository URL
    let repositoryUrl: string | undefined;
    try {
      const git = new Git(this.projectDirectory, this.logger);
      const gitService = new GitService(git, this.logger);
      const gitContext = await gitService.getPackageSourceContext();
      repositoryUrl = gitContext.repositoryUrl;
    } catch {
      // No git available
    }

    const generated = toNpmPackageJson(
      workspacePkgJson,
      this.sfpmPackage,
      this.packageVersionNumber,
      {...this.options, repositoryUrl, sourceHash},
    );

    await fs.writeJson(packageJsonPath, generated, {spaces: 2});
    this.logger?.debug(`Generated package.json at ${packageJsonPath}`);
  }

  /**
   * Validate and return the staging directory.
   * Content has already been staged by PackageAssembler into `artifacts/package/`.
   */
  private prepareStagingDirectory(): string {
    if (!this.sfpmPackage.workingDirectory) {
      throw new ArtifactError(
        this.sfpmPackage.name,
        'assembly',
        'No staging directory available - package must be staged before assembly',
        {version: this.packageVersionNumber},
      );
    }

    this.logger?.debug(`Using staging directory: ${this.sfpmPackage.workingDirectory}`);
    return this.sfpmPackage.workingDirectory;
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
        this.sfpmPackage.name,
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
      this.sfpmPackage.name,
      'assembly',
      `No workspace package.json found for source path "${sourcePath}"`,
      {version: this.packageVersionNumber},
    );
  }
}
