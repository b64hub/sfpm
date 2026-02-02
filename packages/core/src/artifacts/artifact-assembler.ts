import path from 'path';
import fs from 'fs-extra';
import crypto from 'crypto';
import { Logger } from '../types/logger.js';
import SfpmPackage from '../package/sfpm-package.js';
import { VersionManager } from '../project/version-manager.js';
import { SourceHasher } from '../utils/source-hasher.js';
import { SfpmMetadataPackage } from '../package/sfpm-package.js';
import { ArtifactRepository } from './artifact-repository.js';

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

    private repository: ArtifactRepository;
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

        // Create repository for artifact operations
        this.repository = new ArtifactRepository(projectDirectory, logger);

        // artifacts/<package_name>/<version>
        this.versionDirectory = this.repository.getVersionPath(sfpmPackage.packageName, this.packageVersionNumber);

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
            const artifactHash = await this.repository.calculateFileHash(zipPath);
            this.logger?.debug(`Artifact hash: ${artifactHash}`);

            // 9. Update Manifest & Symlink with both hashes
            await this.updateManifest(zipPath, currentSourceHash, artifactHash);
            await this.repository.updateLatestSymlink(this.sfpmPackage.packageName, this.packageVersionNumber);

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
        const zipPath = this.repository.getArtifactZipPath(
            this.sfpmPackage.packageName, 
            this.packageVersionNumber
        );
        await this.repository.createArtifactZip(contentDir, zipPath);
        return zipPath;
    }

    private async updateManifest(zipPath: string, sourceHash: string, artifactHash: string): Promise<void> {
        let manifest = await this.repository.getManifest(this.sfpmPackage.packageName);

        if (!manifest) {
            manifest = {
                name: this.sfpmPackage.packageName,
                latest: '',
                versions: {}
            };
        }

        manifest.latest = this.packageVersionNumber;
        manifest.versions[this.packageVersionNumber] = {
            path: `${this.sfpmPackage.packageName}/${this.packageVersionNumber}/artifact.zip`,
            sourceHash: sourceHash,
            artifactHash: artifactHash,
            generatedAt: Date.now(),
            commit: this.sfpmPackage.commitId
        };

        await this.repository.saveManifest(this.sfpmPackage.packageName, manifest);
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
}
