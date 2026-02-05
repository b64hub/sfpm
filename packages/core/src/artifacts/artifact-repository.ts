import path from 'path';
import fs from 'fs-extra';
import crypto from 'crypto';
import { execSync } from 'child_process';
import { Logger } from '../types/logger.js';
import { ArtifactManifest, ArtifactVersionEntry } from '../types/artifact.js';
import { SfpmPackageMetadata } from '../types/package.js';
import { NpmPackageJson } from '../types/npm.js';
import { ArtifactError } from '../types/errors.js';

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
    private logger?: Logger;
    private projectDirectory: string;
    private artifactsRootDir: string;

    constructor(projectDirectory: string, logger?: Logger) {
        this.logger = logger;
        this.projectDirectory = projectDirectory;
        this.artifactsRootDir = path.join(projectDirectory, 'artifacts');
    }

    /**
     * Get the project directory
     */
    public getProjectDirectory(): string {
        return this.projectDirectory;
    }

    /**
     * Get the root directory for all artifacts
     */
    public getArtifactsRoot(): string {
        return this.artifactsRootDir;
    }

    /**
     * Get the path to a package's artifact directory
     */
    public getPackageArtifactPath(packageName: string): string {
        return path.join(this.artifactsRootDir, packageName);
    }

    /**
     * Get the path to a specific version's directory
     */
    public getVersionPath(packageName: string, version: string): string {
        return path.join(this.getPackageArtifactPath(packageName), version);
    }

    /**
     * Get the absolute path to the artifact file
     */
    public getArtifactPath(packageName: string, version: string): string {
        return path.join(this.getVersionPath(packageName, version), 'artifact.tgz');
    }

    /**
     * Get the relative path to the artifact file (for storage in manifest)
     */
    public getRelativeArtifactPath(packageName: string, version: string): string {
        return `${packageName}/${version}/artifact.tgz`;
    }

    /**
     * Get the path to the manifest file for a package
     */
    private getManifestPath(packageName: string): string {
        return path.join(this.getPackageArtifactPath(packageName), 'manifest.json');
    }

    /**
     * Create a unique temporary directory for downloads/extraction.
     * Pattern: .sfpm/tmp/downloads/[timestamp]-[packageName]-[hash]
     */
    private async createTempDir(packageName: string): Promise<string> {
        const timestamp = new Date().toISOString()
            .replace(/T/, '-')
            .replace(/\..+/, '')
            .replace(/[:-]/g, '');
        const hash = crypto.randomBytes(4).toString('hex');
        const tempDirName = `${timestamp}-${packageName}-${hash}`;
        const tempDir = path.join(this.projectDirectory, DOT_FOLDER, 'tmp', 'downloads', tempDirName);
        await fs.ensureDir(tempDir);
        return tempDir;
    }

    // =========================================================================
    // Existence Checks
    // =========================================================================

    /**
     * Check if any local artifacts exist for a package
     */
    public hasArtifacts(packageName: string): boolean {
        const manifestPath = this.getManifestPath(packageName);
        return fs.existsSync(manifestPath);
    }

    /**
     * Check if a specific version exists locally
     */
    private hasVersion(packageName: string, version: string): boolean {
        const manifest = this.getManifestSync(packageName);
        return manifest?.versions[version] !== undefined;
    }

    /**
     * Check if an artifact exists for a version
     */
    private artifactExists(packageName: string, version: string): boolean {
        const tgzPath = this.getArtifactPath(packageName, version);
        return fs.existsSync(tgzPath);
    }

    // =========================================================================
    // Manifest Operations
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
     * Save the manifest for a package (atomic write)
     */
    private async saveManifest(packageName: string, manifest: ArtifactManifest): Promise<void> {
        const manifestPath = this.getManifestPath(packageName);
        const tempPath = `${manifestPath}.tmp`;

        await fs.ensureDir(path.dirname(manifestPath));

        // Atomic write: write to temp file first, then rename
        await fs.writeJson(tempPath, manifest, { spaces: 4 });
        await fs.move(tempPath, manifestPath, { overwrite: true });
    }

    /**
     * Get the latest version from a package's manifest
     */
    public getLatestVersion(packageName: string): string | undefined {
        const manifest = this.getManifestSync(packageName);
        return manifest?.latest;
    }

    /**
     * Get all local versions for a package
     */
    private getVersions(packageName: string): string[] {
        const manifest = this.getManifestSync(packageName);
        return manifest ? Object.keys(manifest.versions) : [];
    }

    /**
     * Get version entry from manifest
     */
    private getVersionEntry(packageName: string, version: string): ArtifactVersionEntry | undefined {
        const manifest = this.getManifestSync(packageName);
        return manifest?.versions[version];
    }

    /**
     * Add or update a version entry in the manifest
     */
    private async addVersionEntry(
        packageName: string,
        version: string,
        entry: ArtifactVersionEntry,
        updateLatest: boolean = true
    ): Promise<void> {
        let manifest = await this.getManifest(packageName);

        if (!manifest) {
            manifest = {
                name: packageName,
                latest: version,
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
     * Read artifact metadata from a specific version.
     * Reads the sfpm property from package.json inside the tarball.
     */
    public getMetadata(packageName: string, version?: string): SfpmPackageMetadata | undefined {
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

    /**
     * Extract metadata from a tarball (npm package format).
     * Reads the sfpm property from package.json and converts to SfpmPackageMetadata.
     */
    private extractMetadataFromTarball(tarballPath: string): SfpmPackageMetadata | undefined {
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

            // Convert NpmPackageSfpmMetadata to SfpmPackageMetadata
            return this.convertNpmMetadataToSfpm(packageJson);
        } catch (error) {
            this.logger?.debug(`Failed to extract metadata from tarball ${tarballPath}: ${error instanceof Error ? error.message : String(error)}`);
            return undefined;
        }
    }

    /**
     * Extract package.json from a tarball
     */
    private extractPackageJsonFromTarball(tarballPath: string): NpmPackageJson | undefined {
        try {
            // Extract package.json content from tarball without fully extracting
            const packageJsonContent = execSync(
                `tar -xOzf "${tarballPath}" package/package.json`,
                { encoding: 'utf-8', timeout: 30000 }
            );
            return JSON.parse(packageJsonContent);
        } catch (error) {
            this.logger?.debug(`Failed to extract package.json from ${tarballPath}: ${error instanceof Error ? error.message : String(error)}`);
            return undefined;
        }
    }

    /**
     * Convert npm package.json with sfpm metadata to SfpmPackageMetadata
     */
    private convertNpmMetadataToSfpm(packageJson: NpmPackageJson): SfpmPackageMetadata {
        const sfpm = packageJson.sfpm;
        
        // Parse name to get package name (remove scope)
        const packageName = packageJson.name.includes('/') 
            ? packageJson.name.split('/')[1] 
            : packageJson.name;

        // If full metadata is embedded, use it directly
        if (sfpm.metadata) {
            return sfpm.metadata;
        }

        // Otherwise, reconstruct from sfpm properties
        return {
            identity: {
                packageName,
                packageType: sfpm.packageType as any,
                versionNumber: packageJson.version,
                apiVersion: sfpm.apiVersion,
                ...(sfpm.packageId && { packageId: sfpm.packageId }),
                ...(sfpm.packageVersionId && { packageVersionId: sfpm.packageVersionId }),
                ...(sfpm.isOrgDependent !== undefined && { isOrgDependent: sfpm.isOrgDependent }),
            },
            source: {
                commitSHA: sfpm.commitId,
            },
            content: {},
            validation: {},
            orchestration: {},
        } as SfpmPackageMetadata;
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
     * Get comprehensive artifact info for a package
     */
    public getArtifactInfo(
        packageName: string,
        version?: string
    ): {
        version?: string;
        manifest?: ArtifactManifest;
        metadata?: SfpmPackageMetadata;
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
            version: targetVersion,
            manifest,
            metadata,
            versionInfo,
        };
    }

    // =========================================================================
    // Hash Calculation
    // =========================================================================

    /**
     * Calculate SHA-256 hash of a file
     */
    public async calculateFileHash(filePath: string): Promise<string> {
        return new Promise((resolve, reject) => {
            const hash = crypto.createHash('sha256');
            const stream = fs.createReadStream(filePath);

            stream.on('data', (data) => hash.update(data));
            stream.on('end', () => resolve(hash.digest('hex')));
            stream.on('error', reject);
        });
    }

    /**
     * Calculate SHA-256 hash of a file (sync)
     */
    private calculateFileHashSync(filePath: string): string {
        const content = fs.readFileSync(filePath);
        return crypto.createHash('sha256').update(content).digest('hex');
    }

    // =========================================================================
    // Symlink Management
    // =========================================================================

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

    // =========================================================================
    // Artifact Finalization
    // =========================================================================

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
        entry: ArtifactVersionEntry
    ): Promise<void> {
        await this.addVersionEntry(packageName, version, entry, true);
        await this.updateLatestSymlink(packageName, version);
    }

    // =========================================================================
    // Directory Management
    // =========================================================================

    /**
     * Ensure version directory exists
     */
    public async ensureVersionDir(packageName: string, version: string): Promise<string> {
        const versionPath = this.getVersionPath(packageName, version);
        await fs.ensureDir(versionPath);
        return versionPath;
    }

    /**
     * Remove a version directory
     */
    public async removeVersion(packageName: string, version: string): Promise<void> {
        const versionPath = this.getVersionPath(packageName, version);
        await fs.remove(versionPath);
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
        version: string
    ): Promise<{
        artifactPath: string;
        versionEntry: ArtifactVersionEntry;
        metadata?: SfpmPackageMetadata;
        packageVersionId?: string;
    }> {
        const versionDir = this.getVersionPath(packageName, version);
        const artifactPath = this.getArtifactPath(packageName, version);

        try {
            // Ensure version directory exists
            await fs.ensureDir(versionDir);

            // Read sfpm metadata from the tarball's package.json
            const packageJson = this.extractPackageJsonFromTarball(tarballPath);
            
            // Move tarball to the artifacts folder
            await fs.move(tarballPath, artifactPath, { overwrite: true });
            
            const artifactHash = await this.calculateFileHash(artifactPath);
            
            let metadata: SfpmPackageMetadata | undefined;
            let packageVersionId: string | undefined;
            
            if (packageJson?.sfpm) {
                metadata = this.convertNpmMetadataToSfpm(packageJson);
                packageVersionId = packageJson.sfpm.packageVersionId;
            }

            // Use sourceHash from metadata if available, otherwise fall back to artifactHash
            const sourceHash = metadata?.source?.sourceHash || artifactHash;

            // Build version entry
            const versionEntry: ArtifactVersionEntry = {
                path: `${packageName}/${version}/artifact.tgz`,
                artifactHash,
                sourceHash,
                generatedAt: Date.now(),
                packageVersionId,
            };

            // Finalize: update manifest and symlink
            await this.finalizeArtifact(packageName, version, versionEntry);
            
            // Update last checked remote timestamp
            await this.updateLastCheckedRemote(packageName);

            return {
                artifactPath,
                versionEntry,
                metadata,
                packageVersionId,
            };

        } catch (error) {
            throw new ArtifactError(packageName, 'extract', 'Failed to localize tarball', {
                version,
                context: { tarballPath, artifactPath },
                cause: error instanceof Error ? error : new Error(String(error)),
            });
        }
    }

}
