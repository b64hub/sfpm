import path from 'path';
import fs from 'fs-extra';
import crypto from 'crypto';
import { execSync } from 'child_process';
import { EventEmitter } from 'events';
import { Logger } from '../types/logger.js';
import SfpmPackage, { SfpmMetadataPackage } from '../package/sfpm-package.js';
import { VersionManager } from '../project/version-manager.js';
import { ArtifactRepository } from './artifact-repository.js';
import { NpmPackageJson } from '../types/npm.js';
import { ArtifactError } from '../types/errors.js';

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
    /** npm scope for the package (e.g., "@myorg") - required */
    npmScope: string;
    /** Changelog provider for generating changelog.json */
    changelogProvider?: ChangelogProvider;
    /** Additional keywords for package.json */
    additionalKeywords?: string[];
    /** Author string for package.json */
    author?: string;
    /** License identifier for package.json */
    license?: string;
    /** Homepage URL (e.g., AppExchange listing, project docs) */
    homepage?: string;
    /** Pre-classified versioned dependencies (scoped npm name → semver range) */
    versionedDependencies?: Record<string, string>;
    /** Pre-classified managed dependencies (alias → packageVersionId 04t...) */
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
    private repository: ArtifactRepository;
    private versionDirectory: string;
    private packageVersionNumber: string;
    private changelogProvider: ChangelogProvider;
    private options: ArtifactAssemblerOptions;

    constructor(
        private sfpmPackage: SfpmPackage,
        private projectDirectory: string,
        options: ArtifactAssemblerOptions,
        private logger?: Logger,
    ) {
        super();
        this.options = options;
        this.packageVersionNumber = VersionManager.normalizeVersion(sfpmPackage.version || '0.0.0.1');

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

            // 5. Create an empty index.js (npm requires a main entry point)
            await this.createStubEntryPoint(stagingDir);

            // 6. Run npm pack in staging directory
            const tarballName = await this.runNpmPack(stagingDir);

            // 7. Move tarball to version directory
            const artifactPath = await this.moveTarball(stagingDir, tarballName);

            // 8. Calculate artifact hash and finalize
            const artifactHash = await this.finalizeArtifact(artifactPath, currentSourceHash);

            // 9. Cleanup staging directory
            await fs.remove(stagingDir);

            this.emitComplete(artifactPath, currentSourceHash, artifactHash, startTime);
            return artifactPath;
        } catch (error: any) {
            this.emitError(error);
            throw new ArtifactError(this.sfpmPackage.packageName, 'assembly', 'Failed to assemble artifact', {
                version: this.packageVersionNumber,
                cause: error instanceof Error ? error : new Error(String(error)),
            });
        }
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
                if (await fs.pathExists(noiseDir)) {
                    await fs.remove(noiseDir);
                }
            }

            return this.sfpmPackage.stagingDirectory;
        }

        throw new ArtifactError(
            this.sfpmPackage.packageName,
            'assembly',
            'No staging directory available - package must be staged before assembly',
            { version: this.packageVersionNumber },
        );
    }

    /**
     * Generate package.json in the staging directory.
     * Constructs the full npm package.json with sfpm metadata from the package.
     */
    private async generatePackageJson(stagingDir: string): Promise<void> {
        const { npmScope, additionalKeywords, author, license, homepage } = this.options;
        const pkg = this.sfpmPackage;

        // Get sfpm metadata from the package and strip empty properties
        const sfpmMeta = removeEmptyValues(await pkg.toJson());

        // Use pre-classified dependency maps (resolved by caller via ProjectConfig)
        const optionalDependencies = this.options.versionedDependencies ?? {};
        const managedDependencies = this.options.managedDependencies ?? {};

        // Build keywords
        const keywords = ['sfpm', 'salesforce', String(pkg.type), ...(additionalKeywords || [])];

        // Get the package source path (e.g., "force-app", "src", etc.)
        const packageSourcePath = pkg.packageDefinition?.path || 'force-app';

        // Construct package.json
        const packageJson: NpmPackageJson = {
            name: `${npmScope}/${pkg.packageName}`,
            version: this.packageVersionNumber,
            description: pkg.packageDefinition?.versionDescription || `SFPM ${pkg.type} package: ${pkg.packageName}`,
            main: 'index.js',
            keywords,
            license: license || 'UNLICENSED',
            files: [
                `${packageSourcePath}/**`,
                'scripts/**',
                'manifest/**',
                'config/**',
                'sfdx-project.json',
                '.forceignore',
                'changelog.json',
            ],
            sfpm: sfpmMeta,
        };

        // Add optional fields
        if (author) {
            packageJson.author = author;
        }

        if (homepage) {
            packageJson.homepage = homepage;
        }

        if (Object.keys(optionalDependencies).length > 0) {
            packageJson.optionalDependencies = optionalDependencies;
        }

        if (Object.keys(managedDependencies).length > 0) {
            packageJson.managedDependencies = managedDependencies;
        }

        // Add repository if available
        if (pkg.metadata?.source?.repositoryUrl) {
            packageJson.repository = {
                type: 'git',
                url: pkg.metadata.source.repositoryUrl,
            };
        }

        // Write package.json
        const packageJsonPath = path.join(stagingDir, 'package.json');
        await fs.writeJson(packageJsonPath, packageJson, { spaces: 2 });
        this.logger?.debug(`Generated package.json at ${packageJsonPath}`);
    }

    /**
     * Generate changelog.json in the staging directory.
     */
    private async generateChangelog(stagingDir: string): Promise<void> {
        const changelog = await this.changelogProvider.generateChangelog(this.sfpmPackage, this.projectDirectory);
        const changelogPath = path.join(stagingDir, 'changelog.json');
        await fs.writeJson(changelogPath, changelog, { spaces: 4 });
    }

    /**
     * Create a stub index.js file (npm pack requires main entry point).
     */
    private async createStubEntryPoint(stagingDir: string): Promise<void> {
        const indexPath = path.join(stagingDir, 'index.js');
        await fs.writeFile(indexPath, '// SFPM Package - See sfpm metadata in package.json\n');
    }

    /**
     * Run npm pack in the staging directory.
     * @returns The name of the generated tarball file.
     */
    private async runNpmPack(stagingDir: string): Promise<string> {
        this.logger?.debug(`Running npm pack in ${stagingDir}`);

        try {
            // npm pack outputs the filename of the created tarball
            const output = execSync('npm pack', {
                cwd: stagingDir,
                encoding: 'utf-8',
                timeout: 60000,
            }).trim();

            // The output is the tarball filename (e.g., "myorg-my-package-1.0.0-1.tgz")
            const tarballName = output.split('\n').pop()?.trim();

            if (!tarballName || !tarballName.endsWith('.tgz')) {
                throw new Error(`Unexpected npm pack output: ${output}`);
            }

            this.logger?.debug(`npm pack created: ${tarballName}`);

            this.emit('assembly:pack', {
                timestamp: new Date(),
                packageName: this.sfpmPackage.packageName,
                tarballName,
            });

            return tarballName;
        } catch (error) {
            throw new ArtifactError(this.sfpmPackage.packageName, 'pack', 'npm pack failed', {
                version: this.packageVersionNumber,
                context: { stagingDir },
                cause: error instanceof Error ? error : new Error(String(error)),
            });
        }
    }

    /**
     * Move the tarball from staging to the version directory.
     */
    private async moveTarball(stagingDir: string, tarballName: string): Promise<string> {
        const sourcePath = path.join(stagingDir, tarballName);
        const targetPath = this.repository.getArtifactPath(this.sfpmPackage.packageName, this.packageVersionNumber);

        // Ensure version directory exists
        await fs.ensureDir(path.dirname(targetPath));

        // Move the tarball
        await fs.move(sourcePath, targetPath, { overwrite: true });
        this.logger?.debug(`Moved tarball to ${targetPath}`);

        return targetPath;
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
        } else {
            // For non-metadata packages, use a simple timestamp-based hash
            hash = crypto.createHash('sha256').update(Date.now().toString()).digest('hex');
            this.sfpmPackage.sourceHash = hash;
        }

        this.logger?.debug(`Calculated source hash: ${hash}`);
        return hash;
    }

    /**
     * Calculate artifact hash and update manifest.
     */
    private async finalizeArtifact(artifactPath: string, sourceHash: string): Promise<string> {
        const artifactHash = await this.repository.calculateFileHash(artifactPath);
        this.logger?.debug(`Artifact hash: ${artifactHash}`);

        await this.repository.finalizeArtifact(this.sfpmPackage.packageName, this.packageVersionNumber, {
            path: this.repository.getRelativeArtifactPath(this.sfpmPackage.packageName, this.packageVersionNumber),
            sourceHash,
            artifactHash,
            generatedAt: Date.now(),
            commit: this.sfpmPackage.commitId,
        });

        return artifactHash;
    }

    // =========================================================================
    // Event Emission Helpers
    // =========================================================================

    private emitStart(): void {
        this.logger?.info(`Assembling artifact for ${this.sfpmPackage.packageName}@${this.packageVersionNumber}`);
        this.emit('assembly:start', {
            timestamp: new Date(),
            packageName: this.sfpmPackage.packageName,
            version: this.packageVersionNumber,
        });
    }

    private emitComplete(artifactPath: string, sourceHash: string, artifactHash: string, startTime: number): void {
        this.logger?.info(`Artifact successfully stored at ${artifactPath}`);
        this.emit('assembly:complete', {
            timestamp: new Date(),
            packageName: this.sfpmPackage.packageName,
            version: this.packageVersionNumber,
            artifactPath,
            sourceHash,
            artifactHash,
            duration: Date.now() - startTime,
        });
    }

    private emitError(error: any): void {
        this.logger?.error(`Failed to assemble artifact: ${error.message}`);
        this.emit('assembly:error', {
            timestamp: new Date(),
            packageName: this.sfpmPackage.packageName,
            version: this.packageVersionNumber,
            error: error instanceof Error ? error : new Error(String(error)),
        });
    }
}

/**
 * Recursively removes empty values from an object to simplify the output.
 * Removes: empty arrays [], empty objects {}, null, and undefined.
 * Preserves: non-empty values, booleans, numbers (including 0), and non-empty strings.
 */
function removeEmptyValues<T>(obj: T): T {
    if (obj === null || obj === undefined) {
        return obj;
    }

    if (Array.isArray(obj)) {
        return obj.length === 0 ? undefined as unknown as T : obj;
    }

    if (typeof obj === 'object') {
        const cleaned: Record<string, any> = {};

        for (const [key, value] of Object.entries(obj as Record<string, any>)) {
            const cleanedValue = removeEmptyValues(value);

            // Skip undefined, null, empty arrays, and empty objects
            if (cleanedValue === undefined || cleanedValue === null) {
                continue;
            }
            if (Array.isArray(cleanedValue) && cleanedValue.length === 0) {
                continue;
            }
            if (typeof cleanedValue === 'object' && !Array.isArray(cleanedValue) && Object.keys(cleanedValue).length === 0) {
                continue;
            }

            cleaned[key] = cleanedValue;
        }

        return (Object.keys(cleaned).length === 0 ? {} : cleaned) as T;
    }

    return obj;
}
