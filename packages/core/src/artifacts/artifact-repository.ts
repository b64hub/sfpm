import fs from 'fs-extra';
import crypto from 'node:crypto';
import path from 'node:path';

import {DIST_DIR} from '../types/artifact.js';
import Logger from '../types/logger.js';
import {NpmPackageJson} from '../types/npm.js';
import {SfpmPackageMetadataBase} from '../types/package.js';
import {extractPackageVersionId, extractSourceHash, fromNpmPackageJson} from './npm-package-adapter.js';

/**
 * Package-scoped artifact repository.
 *
 * Each instance is bound to a single package workspace and manages the flat
 * build output layout:
 *
 * ```
 * <packageWorkspace>/
 *   dist/
 *     package.json     # contains all build metadata (sfpm.sourceHash, sfpm.packageVersionId, etc.)
 *     force-app/       # salesforce source
 *     CHANGELOG.md     # (if applicable)
 * ```
 *
 * Build metadata is stored directly in `dist/package.json` under the `sfpm`
 * field — no sidecar manifest file. Version history is delegated to
 * Turborepo's content-addressed cache.
 *
 * Used by:
 * - ArtifactAssembler (for writing build output)
 * - ArtifactResolver (for reading and remote localization)
 * - PackageBuilder (for build-skip logic via source hash comparison)
 */
export class ArtifactRepository {
  public readonly packageName?: string;
  private readonly distDir: string;
  private readonly logger?: Logger;
  private readonly packageWorkspacePath: string;

  constructor(packageWorkspacePath: string, logger?: Logger, packageName?: string) {
    this.logger = logger;
    this.packageName = packageName;
    this.packageWorkspacePath = packageWorkspacePath;
    this.distDir = path.join(packageWorkspacePath, DIST_DIR);
  }

  // =========================================================================
  // Path Resolution
  // =========================================================================

  /**
   * Calculate SHA-256 hash of a file.
   */
  public async calculateFileHash(filePath: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const hash = crypto.createHash('sha256');
      const stream = fs.createReadStream(filePath);

      stream.on('data', data => hash.update(data));
      stream.on('end', () => resolve(hash.digest('hex')));
      stream.on('error', reject);
    });
  }

  /**
   * Check whether the source has changed since the last build.
   *
   * Reads the source hash from `dist/package.json` and compares against
   * the current source hash. Returns `undefined` if source has changed
   * (or no previous build exists), otherwise returns the dist path and version.
   */
  public async checkSourceHash(currentSourceHash: string): Promise<undefined | {artifactPath: string; latestVersion: string}> {
    const packageJson = await this.readDistPackageJson();

    if (!packageJson) {
      return undefined;
    }

    const previousHash = extractSourceHash(packageJson);
    if (!previousHash) {
      return undefined;
    }

    if (previousHash === currentSourceHash) {
      return {artifactPath: this.distDir, latestVersion: packageJson.version ?? '0.0.0'};
    }

    this.logger?.debug(`Previous hash: ${previousHash}, current: ${currentSourceHash}`);
    return undefined;
  }

  /**
   * Clean the dist directory.
   */
  public async clean(): Promise<void> {
    await fs.remove(this.distDir);
  }

  /**
   * @deprecated No longer needed — dist/ has no sidecar manifest.
   * Use readDistPackageJson() to read build metadata.
   */
  public getArtifactsDir(): string {
    return this.distDir;
  }

  /**
   * Get the dist directory path (the build output root).
   * This is the publishable, deployable content directory.
   */
  public getDistDir(): string {
    return this.distDir;
  }

  /**
   * Read artifact metadata from `dist/package.json`.
   */
  public getMetadata(): SfpmPackageMetadataBase | undefined {
    const packageJson = this.readDistPackageJsonSync();
    if (!packageJson?.sfpm) {
      return undefined;
    }

    return fromNpmPackageJson(packageJson);
  }

  /**
   * @deprecated Use getDistDir() instead. Kept for migration compatibility.
   */
  public getPackageContentDir(): string {
    return this.distDir;
  }

  /**
   * Extract the packageVersionId from `dist/package.json`.
   */
  public getPackageVersionId(): string | undefined {
    const packageJson = this.readDistPackageJsonSync();
    if (!packageJson) return undefined;
    return extractPackageVersionId(packageJson);
  }

  /**
   * Get the package workspace path this repository is bound to.
   */
  public getPackageWorkspacePath(): string {
    return this.packageWorkspacePath;
  }

  /**
   * Extract the source hash from `dist/package.json`.
   */
  public getSourceHash(): string | undefined {
    const packageJson = this.readDistPackageJsonSync();
    if (!packageJson) return undefined;
    return extractSourceHash(packageJson);
  }

  // =========================================================================
  // Package.json Reading
  // =========================================================================

  /**
   * Extract the version from `dist/package.json`.
   */
  public getVersion(): string | undefined {
    const packageJson = this.readDistPackageJsonSync();
    return packageJson?.version;
  }

  /**
   * Check if a local build output exists (dist/package.json present).
   */
  public hasArtifact(): boolean {
    return fs.existsSync(this.getDistPackageJsonPath());
  }

  // =========================================================================
  // Legacy Compatibility
  // =========================================================================

  /**
   * Read dist/package.json asynchronously.
   */
  public async readDistPackageJson(): Promise<NpmPackageJson | undefined> {
    const pkgJsonPath = this.getDistPackageJsonPath();

    try {
      if (await fs.pathExists(pkgJsonPath)) {
        return await fs.readJson(pkgJsonPath);
      }
    } catch (error) {
      this.logger?.warn(`Failed to read dist/package.json: ${error instanceof Error ? error.message : String(error)}`);
    }

    return undefined;
  }

  /**
   * Read dist/package.json synchronously.
   */
  public readDistPackageJsonSync(): NpmPackageJson | undefined {
    const pkgJsonPath = this.getDistPackageJsonPath();

    try {
      if (fs.existsSync(pkgJsonPath)) {
        return fs.readJsonSync(pkgJsonPath);
      }
    } catch (error) {
      this.logger?.warn(`Failed to read dist/package.json: ${error instanceof Error ? error.message : String(error)}`);
    }

    return undefined;
  }

  // =========================================================================
  // Private Helpers
  // =========================================================================

  private getDistPackageJsonPath(): string {
    return path.join(this.distDir, 'package.json');
  }
}
