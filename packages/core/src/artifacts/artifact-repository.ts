import fs from 'fs-extra';
import {execSync} from 'node:child_process';
import crypto from 'node:crypto';
import path from 'node:path';

import {ArtifactManifest} from '../types/artifact.js';
import {ArtifactError} from '../types/errors.js';
import {Logger} from '../types/logger.js';
import {NpmPackageJson} from '../types/npm.js';
import {SfpmPackageMetadataBase, ValidationState} from '../types/package.js';
import {extractPackageVersionId, extractSourceHash, fromNpmPackageJson} from './npm-package-adapter.js';

/**
 * Subdirectory name for artifact storage within each package workspace.
 */
const ARTIFACTS_DIR = 'artifacts';

/**
 * Package-scoped artifact repository.
 *
 * Each instance is bound to a single package workspace and manages the flat
 * artifact layout:
 *
 * ```
 * <packageWorkspace>/
 *   artifacts/
 *     artifact.tgz      # the single built/downloaded artifact
 *     manifest.json      # metadata sidecar (version, hashes, etc.)
 * ```
 *
 * Version history is delegated to Turborepo's content-addressed cache.
 * This repository only tracks the *current* artifact on disk.
 *
 * Used by:
 * - ArtifactAssembler (for writing build output)
 * - ArtifactResolver (for reading and remote localization)
 */
export class ArtifactRepository {
  public readonly packageName?: string;
  private readonly artifactsDir: string;
  private readonly logger?: Logger;
  private readonly packageWorkspacePath: string;

  constructor(packageWorkspacePath: string, logger?: Logger, packageName?: string) {
    this.logger = logger;
    this.packageName = packageName;
    this.packageWorkspacePath = packageWorkspacePath;
    this.artifactsDir = path.join(packageWorkspacePath, ARTIFACTS_DIR);
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
   * Compares the given source hash against the manifest's recorded hash.
   * Returns `undefined` if source has changed (or no previous build exists),
   * otherwise returns the existing artifact path and version.
   */
  public async checkSourceHash(currentSourceHash: string): Promise<undefined | {artifactPath: string; latestVersion: string}> {
    const manifest = await this.getManifest();

    if (!manifest?.sourceHash) {
      return undefined;
    }

    if (manifest.sourceHash === currentSourceHash) {
      return {artifactPath: this.getPackageContentDir(), latestVersion: manifest.version};
    }

    this.logger?.debug(`Previous hash: ${manifest.sourceHash}, current: ${currentSourceHash}`);
    return undefined;
  }

  /**
   * Clean the artifacts directory.
   */
  public async clean(): Promise<void> {
    await fs.remove(this.artifactsDir);
  }

  /**
   * Finalize a locally built artifact by writing the manifest.
   *
   * @param packageName - Scoped package name
   * @param version - Version string
   * @param artifactHash - SHA-256 of the tarball
   * @param sourceHash - SHA-256 of the source files
   * @param options - Optional commit and packageVersionId
   */
  public async finalizeArtifact(
    packageName: string,
    version: string,
    sourceHash: string,
    options?: {commit?: string; packageVersionId?: string;},
  ): Promise<void> {
    const manifest: ArtifactManifest = {
      commit: options?.commit,
      generatedAt: Date.now(),
      name: packageName,
      packageVersionId: options?.packageVersionId,
      schemaVersion: 2,
      source: 'local',
      sourceHash,
      version,
    };

    await this.saveManifest(manifest);
  }

  // =========================================================================
  // Hash Calculation
  // =========================================================================

  /**
   * Get the absolute path to the artifact tarball.
   */
  public getArtifactPath(): string {
    return path.join(this.artifactsDir, 'artifact.tgz');
  }

  // =========================================================================
  // Existence Checks
  // =========================================================================

  /**
   * Get the artifacts directory path.
   */
  public getArtifactsDir(): string {
    return this.artifactsDir;
  }

  /**
   * Load the manifest (async).
   */
  public async getManifest(): Promise<ArtifactManifest | undefined> {
    const manifestPath = this.getManifestPath();

    try {
      if (await fs.pathExists(manifestPath)) {
        return await fs.readJson(manifestPath);
      }
    } catch (error) {
      this.logger?.warn(`Failed to load manifest: ${error instanceof Error ? error.message : String(error)}`);
    }

    return undefined;
  }

  // =========================================================================
  // Manifest Operations
  // =========================================================================

  /**
   * Load the manifest (sync).
   */
  public getManifestSync(): ArtifactManifest | undefined {
    const manifestPath = this.getManifestPath();

    try {
      if (fs.existsSync(manifestPath)) {
        return fs.readJsonSync(manifestPath);
      }
    } catch (error) {
      this.logger?.warn(`Failed to load manifest: ${error instanceof Error ? error.message : String(error)}`);
    }

    return undefined;
  }

  /**
   * Read artifact metadata from the tarball's package.json.
   */
  public getMetadata(): SfpmPackageMetadataBase | undefined {
    return this.extractMetadataFromTarball(this.getArtifactPath());
  }

  /**
   * Get the package workspace path this repository is bound to.
   */
  public getPackageWorkspacePath(): string {
    return this.packageWorkspacePath;
  }

  /**
   * Get the absolute path to the assembled package content directory.
   * This is the deployable build output (`artifacts/package/`).
   */
  public getPackageContentDir(): string {
    return path.join(this.artifactsDir, 'package');
  }

  /**
   * Check if a local build output exists (manifest present).
   */
  public hasArtifact(): boolean {
    return fs.existsSync(this.getManifestPath());
  }

  /**
   * Check if the artifact tarball exists on disk.
   * Used by the publish flow to verify packable content.
   */
  public hasTarball(): boolean {
    return fs.existsSync(this.getArtifactPath());
  }

  // =========================================================================
  // Artifact Finalization
  // =========================================================================

  // =========================================================================
  // Tarball Localization (remote downloads)
  // =========================================================================

  /**
   * Localize a downloaded tarball into the artifact repository.
   *
   * Responsibilities:
   * 1. Read package.json from tarball to extract sfpm metadata
   * 2. Move tarball to artifacts/artifact.tgz
   * 3. Calculate artifact hash
   * 4. Write manifest with source: 'remote'
   * 5. Update lastCheckedRemote timestamp
   *
   * @param tarballPath - Path to the downloaded .tgz file
   * @param packageName - Name of the package
   * @param version - Version being localized
   */
  public async localizeTarball(
    tarballPath: string,
    packageName: string,
    version: string,
  ): Promise<{
    artifactPath: string;
    manifest: ArtifactManifest;
    metadata?: SfpmPackageMetadataBase;
    packageVersionId?: string;
  }> {
    const artifactPath = this.getArtifactPath();

    try {
      await fs.ensureDir(this.artifactsDir);

      // Read sfpm metadata from the tarball's package.json
      const packageJson = this.extractPackageJsonFromTarball(tarballPath);

      // Move tarball to artifacts/artifact.tgz
      await fs.move(tarballPath, artifactPath, {overwrite: true});

      const artifactHash = await this.calculateFileHash(artifactPath);

      let metadata: SfpmPackageMetadataBase | undefined;
      let packageVersionId: string | undefined;

      if (packageJson?.sfpm) {
        metadata = fromNpmPackageJson(packageJson);
        packageVersionId = extractPackageVersionId(packageJson);
      }

      const sourceHash = (packageJson && extractSourceHash(packageJson)) || artifactHash;

      const manifest: ArtifactManifest = {
        artifactHash,
        generatedAt: Date.now(),
        lastCheckedRemote: Date.now(),
        name: packageName,
        packageVersionId,
        schemaVersion: 2,
        source: 'remote',
        sourceHash,
        version,
      };

      await this.saveManifest(manifest);

      return {
        artifactPath,
        manifest,
        metadata,
        packageVersionId,
      };
    } catch (error) {
      throw new ArtifactError(packageName, 'extract', 'Failed to localize tarball', {
        cause: error instanceof Error ? error : new Error(String(error)),
        context: {artifactPath, tarballPath},
        version,
      });
    }
  }

  // =========================================================================
  // Metadata Extraction
  // =========================================================================

  /**
   * Save a manifest (atomic write).
   */
  public async saveManifest(manifest: ArtifactManifest): Promise<void> {
    const manifestPath = this.getManifestPath();
    const tempPath = `${manifestPath}.tmp`;

    await fs.ensureDir(this.artifactsDir);

    // Atomic write: write to temp file first, then rename
    await fs.writeJson(tempPath, manifest, {spaces: 4});
    await fs.move(tempPath, manifestPath, {overwrite: true});
  }

  /**
   * Update the validation state inside an existing artifact tarball.
   *
   * Extracts `package/package.json` from the tarball, patches the
   * `sfpm.validation` field with the resolved state, repacks the tarball,
   * and recalculates the artifact hash in the manifest.
   *
   * @param validationState - The resolved validation state to write
   */
  public async updateArtifactValidation(validationState: ValidationState): Promise<void> {
    const artifactPath = this.getArtifactPath();
    const name = this.packageName ?? 'unknown';

    if (!await fs.pathExists(artifactPath)) {
      throw new ArtifactError(name, 'update', `Artifact not found at ${artifactPath}`);
    }

    const tempDir = path.join(this.artifactsDir, '.repack-tmp');

    try {
      // 1. Extract tarball into temp directory
      await fs.ensureDir(tempDir);
      execSync(`tar -xzf "${artifactPath}" -C "${tempDir}"`, {timeout: 30_000});

      // 2. Read and patch package.json
      const packageJsonPath = path.join(tempDir, 'package', 'package.json');
      const packageJson: NpmPackageJson = await fs.readJson(packageJsonPath);

      packageJson.sfpm = {
        ...packageJson.sfpm,
        validation: validationState,
      };

      await fs.writeJson(packageJsonPath, packageJson, {spaces: 2});

      // 3. Repack tarball (overwrite original)
      execSync(`tar -czf "${artifactPath}" -C "${tempDir}" package`, {timeout: 60_000});

      // 4. Recalculate artifact hash and update manifest
      const newHash = await this.calculateFileHash(artifactPath);

      const manifest = await this.getManifest();
      if (manifest) {
        manifest.artifactHash = newHash;
        await this.saveManifest(manifest);
      }

      this.logger?.info(`Updated validation state for ${name} to '${validationState.status}'`);
    } catch (error) {
      throw new ArtifactError(name, 'update', 'Failed to update artifact validation state', {
        cause: error instanceof Error ? error : new Error(String(error)),
      });
    } finally {
      await fs.remove(tempDir);
    }
  }

  /**
   * Update lastCheckedRemote timestamp in manifest
   */
  public async updateLastCheckedRemote(): Promise<void> {
    const manifest = await this.getManifest();
    if (manifest) {
      manifest.lastCheckedRemote = Date.now();
      await this.saveManifest(manifest);
    }
  }

  // =========================================================================
  // Private Helpers
  // =========================================================================

  private extractMetadataFromTarball(tarballPath: string): SfpmPackageMetadataBase | undefined {
    try {
      if (!fs.existsSync(tarballPath)) {
        this.logger?.debug(`No artifact.tgz found at ${tarballPath}`);
        return undefined;
      }

      const packageJson = this.extractPackageJsonFromTarball(tarballPath);
      if (!packageJson?.sfpm) {
        this.logger?.debug(`No sfpm metadata found in package.json inside ${tarballPath}`);
        return undefined;
      }

      return fromNpmPackageJson(packageJson);
    } catch (error) {
      this.logger?.debug(`Failed to extract metadata from tarball ${tarballPath}: ${error instanceof Error ? error.message : String(error)}`);
      return undefined;
    }
  }

  private extractPackageJsonFromTarball(tarballPath: string): NpmPackageJson | undefined {
    try {
      const packageJsonContent = execSync(
        `tar -xOzf "${tarballPath}" package/package.json`,
        {encoding: 'utf8', timeout: 30_000},
      );
      return JSON.parse(packageJsonContent);
    } catch (error) {
      this.logger?.debug(`Failed to extract package.json from ${tarballPath}: ${error instanceof Error ? error.message : String(error)}`);
      return undefined;
    }
  }

  private getManifestPath(): string {
    return path.join(this.artifactsDir, 'manifest.json');
  }
}
