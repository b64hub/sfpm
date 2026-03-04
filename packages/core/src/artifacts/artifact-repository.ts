import fs from 'fs-extra';
import {execSync} from 'node:child_process';
import crypto from 'node:crypto';
import path from 'node:path';

import {ArtifactManifest, ArtifactVersionEntry} from '../types/artifact.js';
import {ArtifactError} from '../types/errors.js';
import {Logger} from '../types/logger.js';
import {NpmPackageJson} from '../types/npm.js';
import {SfpmPackageMetadataBase} from '../types/package.js';

/**
 * The hidden folder for SFPM configuration and temporary files
 */
const DOT_FOLDER = '.sfpm';

/**
 * ArtifactRepository handles all filesystem operations for local artifact storage.
 *
 * Responsibilities:
 * - Reading and writing artifact manifests
 * - Reading artifact metadata from zip files
 * - Calculating file and source hashes
 * - Managing 'latest' symlinks
 * - Path resolution for artifacts
 *
 * This class provides the low-level storage abstraction used by:
 * - ArtifactAssembler (for writing)
 * - ArtifactResolver (for reading and remote localization)
 */
export class ArtifactRepository {
  private artifactsRootDir: string;
  private logger?: Logger;
  private projectDirectory: string;

  constructor(projectDirectory: string, logger?: Logger) {
    this.logger = logger;
    this.projectDirectory = projectDirectory;
    this.artifactsRootDir = path.join(projectDirectory, 'artifacts');
  }

  /**
   * Calculate SHA-256 hash of a file
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
   * Ensure version directory exists
   */
  public async ensureVersionDir(packageName: string, version: string): Promise<string> {
    const versionPath = this.getVersionPath(packageName, version);
    await fs.ensureDir(versionPath);
    return versionPath;
  }

  /**
   * Extract packageVersionId from artifact metadata
   */
  public extractPackageVersionId(packageName: string, version?: string): string | undefined {
    const metadata = this.getMetadata(packageName, version);
    if (!metadata?.identity) {
      return undefined;
    }

    // Check for unlocked package identity with versionId
    const identity = metadata.identity as any;
    return identity.packageVersionId;
  }

  /**
   * Finalize an artifact by updating the manifest and symlink.
   *
   * This is a convenience method that combines:
   * 1. Adding/updating the version entry in manifest
   * 2. Updating the latest symlink
   *
   * @param packageName - Name of the package
   * @param version - Version being finalized
   * @param entry - Version entry data for the manifest
   */
  public async finalizeArtifact(
    packageName: string,
    version: string,
    entry: ArtifactVersionEntry,
  ): Promise<void> {
    await this.addVersionEntry(packageName, version, entry, true);
    await this.updateLatestSymlink(packageName, version);
  }

  /**
   * Get comprehensive artifact info for a package
   */
  public getArtifactInfo(
    packageName: string,
    version?: string,
  ): {
    manifest?: ArtifactManifest;
    metadata?: SfpmPackageMetadataBase;
    version?: string;
    versionInfo?: ArtifactVersionEntry;
  } {
    const manifest = this.getManifestSync(packageName);

    if (!manifest) {
      return {};
    }

    const targetVersion = version || manifest.latest;
    const versionInfo = targetVersion ? manifest.versions[targetVersion] : undefined;
    const metadata = this.getMetadata(packageName, targetVersion);

    return {
      manifest,
      metadata,
      version: targetVersion,
      versionInfo,
    };
  }

  /**
   * Get the absolute path to the artifact file
   */
  public getArtifactPath(packageName: string, version: string): string {
    return path.join(this.getVersionPath(packageName, version), 'artifact.tgz');
  }

  /**
   * Get the root directory for all artifacts
   */
  public getArtifactsRoot(): string {
    return this.artifactsRootDir;
  }

  /**
   * Get the latest version from a package's manifest
   */
  public getLatestVersion(packageName: string): string | undefined {
    const manifest = this.getManifestSync(packageName);
    return manifest?.latest;
  }

  // =========================================================================
  // Existence Checks
  // =========================================================================

  /**
   * Load the manifest for a package (async)
   */
  public async getManifest(packageName: string): Promise<ArtifactManifest | undefined> {
    const manifestPath = this.getManifestPath(packageName);

    try {
      if (await fs.pathExists(manifestPath)) {
        return await fs.readJson(manifestPath);
      }
    } catch (error) {
      this.logger?.warn(`Failed to load manifest for ${packageName}: ${error instanceof Error ? error.message : String(error)}`);
    }

    return undefined;
  }

  /**
   * Load the manifest for a package (sync)
   */
  public getManifestSync(packageName: string): ArtifactManifest | undefined {
    const manifestPath = this.getManifestPath(packageName);

    try {
      if (fs.existsSync(manifestPath)) {
        return fs.readJsonSync(manifestPath);
      }
    } catch (error) {
      this.logger?.warn(`Failed to load manifest for ${packageName}: ${error instanceof Error ? error.message : String(error)}`);
    }

    return undefined;
  }

  /**
   * Read artifact metadata from a specific version.
   * Reads the sfpm property from package.json inside the tarball.
   */
  public getMetadata(packageName: string, version?: string): SfpmPackageMetadataBase | undefined {
    try {
      const manifest = this.getManifestSync(packageName);
      if (!manifest) {
        return undefined;
      }

      const targetVersion = version || manifest.latest;
      if (!targetVersion) {
        this.logger?.warn(`No version specified and no latest version in manifest for ${packageName}`);
        return undefined;
      }

      // Check if version exists in manifest
      if (!manifest.versions[targetVersion]) {
        this.logger?.warn(`Version ${targetVersion} not found in manifest for ${packageName}`);
        return undefined;
      }

      const tgzPath = this.getArtifactPath(packageName, targetVersion);
      return this.extractMetadataFromTarball(tgzPath);
    } catch (error) {
      this.logger?.warn(`Failed to read artifact metadata: ${error instanceof Error ? error.message : String(error)}`);
      return undefined;
    }
  }

  // =========================================================================
  // Manifest Operations
  // =========================================================================

  /**
   * Get the path to a package's artifact directory
   */
  public getPackageArtifactPath(packageName: string): string {
    return path.join(this.artifactsRootDir, packageName);
  }

  /**
   * Get the project directory
   */
  public getProjectDirectory(): string {
    return this.projectDirectory;
  }

  /**
   * Get the relative path to the artifact file (for storage in manifest)
   */
  public getRelativeArtifactPath(packageName: string, version: string): string {
    return `${packageName}/${version}/artifact.tgz`;
  }

  /**
   * Get the path to a specific version's directory
   */
  public getVersionPath(packageName: string, version: string): string {
    return path.join(this.getPackageArtifactPath(packageName), version);
  }

  /**
   * Check if any local artifacts exist for a package
   */
  public hasArtifacts(packageName: string): boolean {
    const manifestPath = this.getManifestPath(packageName);
    return fs.existsSync(manifestPath);
  }

  /**
   * Localize a downloaded tarball into the artifact repository.
   *
   * This method owns the full responsibility of "localization":
   * 1. Read package.json from tarball to extract sfpm metadata
   * 2. Move tarball to artifacts/<package>/<version>/artifact.tgz
   * 3. Calculate artifact hash
   * 4. Build and save version entry in manifest
   * 5. Update 'latest' symlink
   * 6. Update lastCheckedRemote timestamp
   *
   * @param tarballPath - Path to the downloaded .tgz file
   * @param packageName - Name of the package
   * @param version - Version being localized
   * @returns Localized artifact info including version entry
   */
  public async localizeTarball(
    tarballPath: string,
    packageName: string,
    version: string,
  ): Promise<{
    artifactPath: string;
    metadata?: SfpmPackageMetadataBase;
    packageVersionId?: string;
    versionEntry: ArtifactVersionEntry;
  }> {
    const versionDir = this.getVersionPath(packageName, version);
    const artifactPath = this.getArtifactPath(packageName, version);

    try {
      // Ensure version directory exists
      await fs.ensureDir(versionDir);

      // Read sfpm metadata from the tarball's package.json
      const packageJson = this.extractPackageJsonFromTarball(tarballPath);

      // Move tarball to the artifacts folder
      await fs.move(tarballPath, artifactPath, {overwrite: true});

      const artifactHash = await this.calculateFileHash(artifactPath);

      let metadata: SfpmPackageMetadataBase | undefined;
      let packageVersionId: string | undefined;

      if (packageJson?.sfpm) {
        metadata = this.convertNpmMetadataToSfpm(packageJson);
        packageVersionId = packageJson.sfpm.packageVersionId;
      }

      // Use sourceHash from metadata if available, otherwise fall back to artifactHash
      const sourceHash = metadata?.source?.sourceHash || artifactHash;

      // Build version entry
      const versionEntry: ArtifactVersionEntry = {
        artifactHash,
        generatedAt: Date.now(),
        packageVersionId,
        path: `${packageName}/${version}/artifact.tgz`,
        sourceHash,
      };

      // Finalize: update manifest and symlink
      await this.finalizeArtifact(packageName, version, versionEntry);

      // Update last checked remote timestamp
      await this.updateLastCheckedRemote(packageName);

      return {
        artifactPath,
        metadata,
        packageVersionId,
        versionEntry,
      };
    } catch (error) {
      throw new ArtifactError(packageName, 'extract', 'Failed to localize tarball', {
        cause: error instanceof Error ? error : new Error(String(error)),
        context: {artifactPath, tarballPath},
        version,
      });
    }
  }

  /**
   * Remove a version directory
   */
  public async removeVersion(packageName: string, version: string): Promise<void> {
    const versionPath = this.getVersionPath(packageName, version);
    await fs.remove(versionPath);
  }

  /**
   * Update lastCheckedRemote timestamp in manifest
   */
  public async updateLastCheckedRemote(packageName: string): Promise<void> {
    const manifest = await this.getManifest(packageName);
    if (manifest) {
      manifest.lastCheckedRemote = Date.now();
      await this.saveManifest(packageName, manifest);
    }
  }

  // =========================================================================
  // Metadata Operations
  // =========================================================================

  /**
   * Add or update a version entry in the manifest
   */
  private async addVersionEntry(
    packageName: string,
    version: string,
    entry: ArtifactVersionEntry,
    updateLatest: boolean = true,
  ): Promise<void> {
    let manifest = await this.getManifest(packageName);

    if (!manifest) {
      manifest = {
        latest: version,
        name: packageName,
        versions: {},
      };
    }

    manifest.versions[version] = entry;

    if (updateLatest) {
      manifest.latest = version;
    }

    await this.saveManifest(packageName, manifest);
  }

  /**
   * Check if an artifact exists for a version
   */
  private artifactExists(packageName: string, version: string): boolean {
    const tgzPath = this.getArtifactPath(packageName, version);
    return fs.existsSync(tgzPath);
  }

  /**
   * Calculate SHA-256 hash of a file (sync)
   */
  private calculateFileHashSync(filePath: string): string {
    const content = fs.readFileSync(filePath);
    return crypto.createHash('sha256').update(content).digest('hex');
  }

  /**
   * Convert npm package.json with sfpm metadata to SfpmPackageMetadataBase
   */
  private convertNpmMetadataToSfpm(packageJson: NpmPackageJson): SfpmPackageMetadataBase {
    const {sfpm} = packageJson;

    // Parse name to get package name (remove scope)
    const packageName = packageJson.name.includes('/')
      ? packageJson.name.split('/')[1]
      : packageJson.name;

    // If full metadata is embedded, use it directly
    if (sfpm.metadata) {
      return sfpm.metadata;
    }

    // Otherwise, reconstruct base metadata from sfpm properties
    return {
      identity: {
        apiVersion: sfpm.apiVersion,
        packageName,
        packageType: sfpm.packageType as any,
        versionNumber: packageJson.version,
        ...(sfpm.packageId && {packageId: sfpm.packageId}),
        ...(sfpm.packageVersionId && {packageVersionId: sfpm.packageVersionId}),
        ...(sfpm.isOrgDependent !== undefined && {isOrgDependent: sfpm.isOrgDependent}),
      },
      orchestration: {},
      source: {
        commitSHA: sfpm.commitId,
      },
    } as SfpmPackageMetadataBase;
  }

  /**
   * Create a unique temporary directory for downloads/extraction.
   * Pattern: .sfpm/tmp/downloads/[timestamp]-[packageName]-[hash]
   */
  private async createTempDir(packageName: string): Promise<string> {
    const timestamp = new Date().toISOString()
    .replace(/T/, '-')
    .replace(/\..+/, '')
    .replaceAll(/[:-]/g, '');
    const hash = crypto.randomBytes(4).toString('hex');
    const tempDirName = `${timestamp}-${packageName}-${hash}`;
    const tempDir = path.join(this.projectDirectory, DOT_FOLDER, 'tmp', 'downloads', tempDirName);
    await fs.ensureDir(tempDir);
    return tempDir;
  }

  /**
   * Extract metadata from a tarball (npm package format).
   * Reads the sfpm property from package.json and converts to SfpmPackageMetadataBase.
   */
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

      // Convert NpmPackageSfpmMetadata to SfpmPackageMetadataBase
      return this.convertNpmMetadataToSfpm(packageJson);
    } catch (error) {
      this.logger?.debug(`Failed to extract metadata from tarball ${tarballPath}: ${error instanceof Error ? error.message : String(error)}`);
      return undefined;
    }
  }

  // =========================================================================
  // Hash Calculation
  // =========================================================================

  /**
   * Extract package.json from a tarball
   */
  private extractPackageJsonFromTarball(tarballPath: string): NpmPackageJson | undefined {
    try {
      // Extract package.json content from tarball without fully extracting
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

  /**
   * Get the path to the manifest file for a package
   */
  private getManifestPath(packageName: string): string {
    return path.join(this.getPackageArtifactPath(packageName), 'manifest.json');
  }

  // =========================================================================
  // Symlink Management
  // =========================================================================

  /**
   * Get version entry from manifest
   */
  private getVersionEntry(packageName: string, version: string): ArtifactVersionEntry | undefined {
    const manifest = this.getManifestSync(packageName);
    return manifest?.versions[version];
  }

  // =========================================================================
  // Artifact Finalization
  // =========================================================================

  /**
   * Get all local versions for a package
   */
  private getVersions(packageName: string): string[] {
    const manifest = this.getManifestSync(packageName);
    return manifest ? Object.keys(manifest.versions) : [];
  }

  // =========================================================================
  // Directory Management
  // =========================================================================

  /**
   * Check if a specific version exists locally
   */
  private hasVersion(packageName: string, version: string): boolean {
    const manifest = this.getManifestSync(packageName);
    return manifest?.versions[version] !== undefined;
  }

  /**
   * Save the manifest for a package (atomic write)
   */
  private async saveManifest(packageName: string, manifest: ArtifactManifest): Promise<void> {
    const manifestPath = this.getManifestPath(packageName);
    const tempPath = `${manifestPath}.tmp`;

    await fs.ensureDir(path.dirname(manifestPath));

    // Atomic write: write to temp file first, then rename
    await fs.writeJson(tempPath, manifest, {spaces: 4});
    await fs.move(tempPath, manifestPath, {overwrite: true});
  }

  /**
   * Update the 'latest' symlink to point to a version directory
   */
  private async updateLatestSymlink(packageName: string, version: string): Promise<void> {
    const packageArtifactRoot = this.getPackageArtifactPath(packageName);
    const symlinkPath = path.join(packageArtifactRoot, 'latest');

    try {
      // Remove existing symlink if present
      if (await fs.pathExists(symlinkPath)) {
        await fs.remove(symlinkPath);
      }

      // Create relative symlink (version directory name is relative to package root)
      // Use 'junction' for Windows compatibility
      await fs.symlink(version, symlinkPath, 'junction');
    } catch (error) {
      // Symlinks might fail on some systems (Windows without admin)
      this.logger?.warn(`Symlink failed: ${error instanceof Error ? error.message : String(error)}. Falling back to latest.version identifier.`);

      // Fallback: write version to a file
      const versionFilePath = path.join(packageArtifactRoot, 'latest.version');
      await fs.writeFile(versionFilePath, version);
    }
  }
}
