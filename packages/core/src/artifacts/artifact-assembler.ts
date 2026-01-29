import path from 'path';
import fs from 'fs-extra';
import archiver from 'archiver';
import crypto from 'crypto';
import { Logger } from '../types/logger.js';
import SfpmPackage from '../package/sfpm-package.js';
import { VersionManager } from '../project/version-manager.js';
import { SourceHasher } from '../utils/source-hasher.js';
import { SfpmMetadataPackage } from '../package/sfpm-package.js';
import { ArtifactManifest } from '../types/artifact.js';

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
    async generateChangelog(pkg: SfpmPackage, projectDirectory: string): Promise<any> {
        return {
            message: "Changelog generation is currently disabled.",
            timestamp: Date.now()
        };
    }
}

/**
 * @description Assembles artifacts in a structured monorepo format.
 */
export default class ArtifactAssembler {

    private packageArtifactRoot: string;
    private versionDirectory: string;
    private packageVersionNumber: string;
    private changelogProvider: ChangelogProvider;

    constructor(
        private sfpmPackage: SfpmPackage,
        private projectDirectory: string,
        private artifactsRootDir: string,
        private logger?: Logger,
        changelogProvider?: ChangelogProvider
    ) {
        this.packageVersionNumber = VersionManager.normalizeVersion(
            sfpmPackage.version || '0.0.0.1'
        );

        // artifacts/<package_name>
        this.packageArtifactRoot = path.join(this.artifactsRootDir, sfpmPackage.packageName);

        // artifacts/<package_name>/<version>
        this.versionDirectory = path.join(this.packageArtifactRoot, this.packageVersionNumber);

        this.changelogProvider = changelogProvider || new StubChangelogProvider();
    }

    /**
     * @description Orchestrates the artifact assembly process.
     * Always assembles when called - pre-build checks should happen elsewhere.
     * @returns {Promise<string>} The path to the generated artifact.zip.
     */
    public async assemble(): Promise<string> {
        try {
            this.logger?.info(`Assembling artifact for ${this.sfpmPackage.packageName}@${this.packageVersionNumber}`);

            // 1. Calculate sourceHash from current package state
            const currentSourceHash = await this.calculateSourceHash();
            this.logger?.debug(`Current source hash: ${currentSourceHash}`);

            // 2. Prepare Version Directory
            await fs.ensureDir(this.versionDirectory);

            // 3. Generate Metadata (before moving staging directory)
            const metadata = await (this.sfpmPackage as any).toPackageMetadata();

            // 4. Prepare Source (Copy and Clean)
            const stagingSourceDir = await this.prepareSource();

            // 5. Write Metadata to staging source
            const metadataPath = path.join(stagingSourceDir, `artifact_metadata.json`);
            await fs.writeJson(metadataPath, metadata, { spaces: 4 });

            // 6. Generate Changelog (using provider)
            await this.generateChangelog(stagingSourceDir);

            // 7. Create Zip using Archiver (with deterministic timestamps)
            const zipPath = await this.createZip(stagingSourceDir);

            // 8. Calculate artifactHash from the generated zip
            const artifactHash = await this.calculateFileHash(zipPath);
            this.logger?.debug(`Artifact hash: ${artifactHash}`);

            // 9. Update Manifest & Symlink with both hashes
            await this.updateManifest(zipPath, currentSourceHash, artifactHash);
            await this.updateLatestSymlink();

            // 10. Cleanup staging source
            await fs.remove(stagingSourceDir);

            this.logger?.info(`Artifact successfully stored at ${zipPath}`);
            return zipPath;
        } catch (error: any) {
            this.logger?.error(`Failed to assemble artifact: ${error.message}`);
            throw new Error('Unable to create artifact: ' + error.message);
        }
    }

    private async prepareSource(): Promise<string> {
        const stagingSourceDir = path.join(this.versionDirectory, 'source');
        await fs.ensureDir(stagingSourceDir);

        if (this.sfpmPackage.stagingDirectory) {
            this.logger?.debug(`Preparing source from staging directory: ${this.sfpmPackage.stagingDirectory}`);
            this.logger?.debug(`Target staging source directory: ${stagingSourceDir}`);
            
            // Cleanup noise from staging directory if it exists
            const noise = ['.sfpm', '.sfdx'];
            for (const dir of noise) {
                const noiseDir = path.join(this.sfpmPackage.stagingDirectory, dir);
                if (await fs.pathExists(noiseDir)) {
                    await fs.remove(noiseDir);
                }
            }

            // Copy staging contents to artifact source
            await fs.copy(this.sfpmPackage.stagingDirectory, stagingSourceDir);

            // Cleanup the original staging directory (as it's transient)
            await fs.remove(this.sfpmPackage.stagingDirectory);
        }

        return stagingSourceDir;
    }

    private async generateChangelog(stagingDir: string): Promise<void> {
        const changelog = await this.changelogProvider.generateChangelog(this.sfpmPackage, this.projectDirectory);
        const changelogPath = path.join(stagingDir, `changelog.json`);
        await fs.writeJson(changelogPath, changelog, { spaces: 4 });
    }

    private async createZip(contentDir: string): Promise<string> {
        const zipPath = path.join(this.versionDirectory, 'artifact.zip');
        const output = fs.createWriteStream(zipPath);
        const archive = archiver('zip', {
            zlib: { level: 9 }
        });

        return new Promise((resolve, reject) => {
            output.on('close', () => resolve(zipPath));
            archive.on('error', (err) => reject(err));

            archive.pipe(output);

            // Add the contents of the staging directory with deterministic timestamps
            // Set all file modification times to a fixed date for reproducible builds
            const deterministicDate = new Date('1980-01-01T00:00:00.000Z');
            
            archive.directory(contentDir, false, (entry: any) => {
                // Force deterministic timestamps for all entries
                entry.date = deterministicDate;
                return entry;
            });

            archive.finalize();
        });
    }

    private async updateManifest(zipPath: string, sourceHash: string, artifactHash: string): Promise<void> {
        const manifestPath = path.join(this.packageArtifactRoot, 'manifest.json');
        let manifest: ArtifactManifest;

        if (await fs.pathExists(manifestPath)) {
            manifest = await fs.readJson(manifestPath);
        } else {
            manifest = {
                name: this.sfpmPackage.packageName,
                latest: '',
                versions: {}
            };
        }

        manifest.latest = this.packageVersionNumber;
        manifest.versions[this.packageVersionNumber] = {
            path: path.relative(this.artifactsRootDir, zipPath),
            sourceHash: sourceHash,
            artifactHash: artifactHash,
            generatedAt: Date.now(),
            commit: this.sfpmPackage.commitId
        };

        await fs.writeJson(manifestPath, manifest, { spaces: 4 });
    }

    private async updateLatestSymlink(): Promise<void> {
        const symlinkPath = path.join(this.packageArtifactRoot, 'latest');

        try {
            await fs.remove(symlinkPath);
        } catch (e) { }

        try {
            const target = path.join('.', this.packageVersionNumber);
            // 'junction' is more reliable for directory links on Windows
            await fs.symlink(target, symlinkPath, 'junction');
        } catch (e: any) {
            this.logger?.warn(`Symlink failed: ${e.message}. Falling back to latest.version identifier.`);
            const versionFilePath = path.join(this.packageArtifactRoot, 'latest.version');
            await fs.writeFile(versionFilePath, this.packageVersionNumber);
        }
    }

    /**
     * Calculate a stable hash from the package's source components.
     * Uses the ComponentSet to ensure consistency with .forceignore rules.
     */
    private async calculateSourceHash(): Promise<string> {
        if (!(this.sfpmPackage instanceof SfpmMetadataPackage)) {
            // For non-metadata packages, use a simple timestamp-based hash
            return crypto.createHash('sha256').update(Date.now().toString()).digest('hex');
        }

        return await SourceHasher.calculate(this.sfpmPackage);
    }

    /**
     * Calculate the SHA256 hash of a file using streams to avoid loading large files into memory.
     * @param filePath Path to the file to hash
     */
    private async calculateFileHash(filePath: string): Promise<string> {
        return new Promise((resolve, reject) => {
            const hash = crypto.createHash('sha256');
            const stream = fs.createReadStream(filePath);

            stream.on('data', (chunk) => hash.update(chunk));
            stream.on('end', () => resolve(hash.digest('hex')));
            stream.on('error', (err) => reject(err));
        });
    }
}
