import path from 'path';
import fs from 'fs-extra';
import crypto from 'crypto';
import AdmZip from 'adm-zip';
import archiver from 'archiver';
import { Logger } from '../types/logger.js';
import { ArtifactManifest, ArtifactVersionEntry } from '../types/artifact.js';
import { SfpmPackageMetadata } from '../types/package.js';
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

    // =========================================================================
    // Path Resolution
    // =========================================================================

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
     * Get the path to a specific version's artifact.zip
     */
    public getArtifactZipPath(packageName: string, version: string): string {
        return path.join(this.getVersionPath(packageName, version), 'artifact.zip');
    }

    /**
     * Get the path to the manifest file for a package
     */
    public getManifestPath(packageName: string): string {
        return path.join(this.getPackageArtifactPath(packageName), 'manifest.json');
    }

    /**
     * Create a unique temporary directory for downloads/extraction.
     * Pattern: .sfpm/tmp/downloads/[timestamp]-[packageName]-[hash]
     */
    public async createTempDir(packageName: string): Promise<string> {
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
    public hasVersion(packageName: string, version: string): boolean {
        const manifest = this.getManifestSync(packageName);
        return manifest?.versions[version] !== undefined;
    }

    /**
     * Check if an artifact.zip exists for a version
     */
    public artifactZipExists(packageName: string, version: string): boolean {
        const zipPath = this.getArtifactZipPath(packageName, version);
        return fs.existsSync(zipPath);
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
    public async saveManifest(packageName: string, manifest: ArtifactManifest): Promise<void> {
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
    public getVersions(packageName: string): string[] {
        const manifest = this.getManifestSync(packageName);
        return manifest ? Object.keys(manifest.versions) : [];
    }

    /**
     * Get version entry from manifest
     */
    public getVersionEntry(packageName: string, version: string): ArtifactVersionEntry | undefined {
        const manifest = this.getManifestSync(packageName);
        return manifest?.versions[version];
    }

    /**
     * Add or update a version entry in the manifest
     */
    public async addVersionEntry(
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
     * Read artifact metadata from a specific version
     * Extracts artifact_metadata.json from the artifact zip
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

            const zipPath = this.getArtifactZipPath(packageName, targetVersion);
            return this.extractMetadataFromZip(zipPath);
        } catch (error) {
            this.logger?.warn(`Failed to read artifact metadata: ${error instanceof Error ? error.message : String(error)}`);
            return undefined;
        }
    }

    /**
     * Extract metadata from an artifact zip file
     */
    public extractMetadataFromZip(zipPath: string): SfpmPackageMetadata | undefined {
        try {
            if (!fs.existsSync(zipPath)) {
                this.logger?.debug(`No artifact.zip found at ${zipPath}`);
                return undefined;
            }

            const zip = new AdmZip(zipPath);
            const metadataEntry = zip.getEntry('artifact_metadata.json');

            if (!metadataEntry) {
                this.logger?.debug(`No artifact_metadata.json found inside ${zipPath}`);
                return undefined;
            }

            const metadataContent = zip.readAsText(metadataEntry);
            return JSON.parse(metadataContent);
        } catch (error) {
            this.logger?.debug(`Failed to extract metadata from ${zipPath}: ${error instanceof Error ? error.message : String(error)}`);
            return undefined;
        }
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
    public calculateFileHashSync(filePath: string): string {
        const content = fs.readFileSync(filePath);
        return crypto.createHash('sha256').update(content).digest('hex');
    }

    // =========================================================================
    // Symlink Management
    // =========================================================================

    /**
     * Update the 'latest' symlink to point to a version directory
     */
    public async updateLatestSymlink(packageName: string, version: string): Promise<void> {
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

    // =========================================================================
    // Zip Creation
    // =========================================================================

    /**
     * Create a zip file from a source directory with deterministic timestamps
     */
    public async createArtifactZip(sourceDir: string, targetPath: string): Promise<void> {
        const output = fs.createWriteStream(targetPath);
        const archive = archiver('zip', { zlib: { level: 9 } });

        return new Promise((resolve, reject) => {
            output.on('close', () => resolve());
            archive.on('error', (err) => reject(err));

            archive.pipe(output);

            // Set all file modification times to a fixed date for reproducible builds
            const deterministicDate = new Date('1980-01-01T00:00:00.000Z');

            archive.directory(sourceDir, false, (entry: any) => {
                entry.date = deterministicDate;
                return entry;
            });

            archive.finalize();
        });
    }

    // =========================================================================
    // Tarball Localization
    // =========================================================================

    /**
     * Localize a downloaded tarball into the artifact repository.
     * 
     * This method:
     * 1. Creates a temp directory under .sfpm/tmp/downloads/
     * 2. Extracts the tarball to the temp directory
     * 3. Looks for existing SFPM artifacts inside
     * 4. If found, copies the artifact.zip directly
     * 5. If not found, creates a new artifact.zip from package contents
     * 6. Cleans up temporary files
     * 
     * @param tarballPath - Path to the downloaded .tgz file
     * @param packageName - Name of the package
     * @param version - Version being localized
     * @returns Localization result with artifact path and metadata
     */
    public async localizeFromTarball(
        tarballPath: string,
        packageName: string,
        version: string
    ): Promise<{
        artifactPath: string;
        artifactHash: string;
        metadata?: SfpmPackageMetadata;
        packageVersionId?: string;
    }> {
        const versionDir = this.getVersionPath(packageName, version);
        const artifactPath = this.getArtifactZipPath(packageName, version);
        
        // Create temp dir under .sfpm/tmp/downloads/ for extraction
        const extractDir = await this.createTempDir(packageName);

        try {
            // Ensure version directory exists
            await fs.ensureDir(versionDir);

            // Extract tarball using tar command
            const { execSync } = await import('child_process');
            execSync(`tar -xzf "${tarballPath}" -C "${extractDir}"`, {
                encoding: 'utf-8',
                timeout: 60000,
            });

            // npm packages extract to a 'package' subdirectory
            const packageDir = path.join(extractDir, 'package');
            
            // Look for existing SFPM artifacts inside the package
            const existingArtifactsDir = path.join(packageDir, 'artifacts');
            let foundExisting = false;
            
            if (await fs.pathExists(existingArtifactsDir)) {
                // This is an SFPM package - find the artifact.zip inside
                foundExisting = await this.findAndCopyExistingArtifact(
                    existingArtifactsDir,
                    artifactPath
                );
            }

            if (!foundExisting) {
                // No pre-built artifact - create one from the package contents
                await this.createArtifactZip(packageDir, artifactPath);
            }

            // Calculate hash
            const artifactHash = await this.calculateFileHash(artifactPath);

            // Extract metadata
            const metadata = this.extractMetadataFromZip(artifactPath);
            let packageVersionId: string | undefined;

            if (metadata?.identity) {
                const identity = metadata.identity as any;
                if (identity.packageVersionId) {
                    packageVersionId = identity.packageVersionId;
                }
            }

            // Cleanup
            await fs.remove(extractDir);
            await fs.remove(tarballPath);

            return {
                artifactPath,
                artifactHash,
                metadata,
                packageVersionId,
            };

        } catch (error) {
            // Cleanup on failure
            await fs.remove(extractDir).catch(() => { /* ignore */ });
            
            throw new ArtifactError(packageName, 'extract', 'Failed to localize tarball', {
                version,
                context: { tarballPath, artifactPath },
                cause: error instanceof Error ? error : new Error(String(error)),
            });
        }
    }

    /**
     * Search for and copy an existing artifact.zip from an SFPM package.
     * 
     * SFPM packages published to npm include their artifacts directory.
     * This searches through that directory to find the correct artifact.zip.
     * 
     * @param artifactsDir - Path to the 'artifacts' directory inside the package
     * @param targetPath - Where to copy the found artifact.zip
     * @returns True if an artifact was found and copied
     */
    private async findAndCopyExistingArtifact(
        artifactsDir: string,
        targetPath: string
    ): Promise<boolean> {
        try {
            const packageDirs = await fs.readdir(artifactsDir);
            
            for (const pkgDir of packageDirs) {
                const pkgPath = path.join(artifactsDir, pkgDir);
                const stat = await fs.stat(pkgPath);
                
                if (!stat.isDirectory()) continue;

                const versionDirs = await fs.readdir(pkgPath);
                
                for (const vDir of versionDirs) {
                    const zipPath = path.join(pkgPath, vDir, 'artifact.zip');
                    
                    if (await fs.pathExists(zipPath)) {
                        await fs.copy(zipPath, targetPath);
                        this.logger?.debug(`Found existing artifact at ${zipPath}`);
                        return true;
                    }
                }
            }
        } catch (error) {
            this.logger?.debug(`Error searching for existing artifact: ${error instanceof Error ? error.message : String(error)}`);
        }

        return false;
    }
}
