import path from 'path';
import fs from 'fs-extra';
import crypto from 'crypto';
import { execSync } from 'child_process';
import { Logger } from '../types/logger.js';
import SfpmPackage from '../package/sfpm-package.js';
import { VersionManager } from '../project/version-manager.js';
import { SourceHasher } from '../utils/source-hasher.js';
import { SfpmMetadataPackage } from '../package/sfpm-package.js';
import { ArtifactRepository } from './artifact-repository.js';
import { NpmPackageJson, convertDependencyToNpm } from '../types/npm.js';
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
            message: "Changelog generation is currently disabled.",
            timestamp: Date.now()
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
export default class ArtifactAssembler {

    private repository: ArtifactRepository;
    private versionDirectory: string;
    private packageVersionNumber: string;
    private changelogProvider: ChangelogProvider;
    private options: ArtifactAssemblerOptions;

    constructor(
        private sfpmPackage: SfpmPackage,
        private projectDirectory: string,
        options: ArtifactAssemblerOptions,
        private logger?: Logger
    ) {
        this.options = options;
        this.packageVersionNumber = VersionManager.normalizeVersion(
            sfpmPackage.version || '0.0.0.1'
        );

        // Create repository for artifact operations
        this.repository = new ArtifactRepository(projectDirectory, logger);

        // artifacts/<package_name>/<version>
        this.versionDirectory = this.repository.getVersionPath(
            sfpmPackage.packageName, 
            this.packageVersionNumber
        );

        this.changelogProvider = options.changelogProvider || new StubChangelogProvider();
    }

    /**
     * @description Orchestrates the artifact assembly process using npm pack.
     * @returns {Promise<string>} The path to the generated artifact.tgz.
     */
    public async assemble(): Promise<string> {
        try {
            this.logger?.info(`Assembling artifact for ${this.sfpmPackage.packageName}@${this.packageVersionNumber}`);

            // 1. Calculate sourceHash from current package state
            const currentSourceHash = await this.calculateSourceHash();
            this.logger?.debug(`Current source hash: ${currentSourceHash}`);

            // 2. Prepare staging directory with source files
            const stagingDir = await this.prepareStagingDirectory();

            // 3. Generate package.json with sfpm metadata
            await this.generatePackageJson(stagingDir, currentSourceHash);

            // 4. Generate changelog
            await this.generateChangelog(stagingDir);

            // 5. Create an empty index.js (npm requires a main entry point)
            await this.createStubEntryPoint(stagingDir);

            // 6. Run npm pack in staging directory
            const tarballName = await this.runNpmPack(stagingDir);

            // 7. Move tarball to version directory
            const artifactPath = await this.moveTarball(stagingDir, tarballName);

            // 8. Calculate artifact hash
            const artifactHash = await this.repository.calculateFileHash(artifactPath);
            this.logger?.debug(`Artifact hash: ${artifactHash}`);

            // 9. Update manifest and symlink via repository
            await this.repository.finalizeArtifact(
                this.sfpmPackage.packageName,
                this.packageVersionNumber,
                {
                    path: this.repository.getArtifactPath(this.sfpmPackage.packageName, this.packageVersionNumber),
                    sourceHash: currentSourceHash,
                    artifactHash: artifactHash,
                    generatedAt: Date.now(),
                    commit: this.sfpmPackage.commitId
                }
            );

            // 10. Cleanup staging directory
            await fs.remove(stagingDir);

            this.logger?.info(`Artifact successfully stored at ${artifactPath}`);
            return artifactPath;

        } catch (error: any) {
            this.logger?.error(`Failed to assemble artifact: ${error.message}`);
            throw new ArtifactError(
                this.sfpmPackage.packageName,
                'assembly',
                'Failed to assemble artifact',
                {
                    version: this.packageVersionNumber,
                    cause: error instanceof Error ? error : new Error(String(error))
                }
            );
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
            { version: this.packageVersionNumber }
        );
    }

    /**
     * Generate package.json in the staging directory.
     * Constructs the full npm package.json with sfpm metadata from the package.
     */
    private async generatePackageJson(stagingDir: string, sourceHash: string): Promise<void> {
        const { npmScope, additionalKeywords, author, license } = this.options;
        const pkg = this.sfpmPackage;

        // Get sfpm metadata from the package
        const sfpmMeta = await pkg.toJson();

        // Build optional dependencies from sfdx-project.json dependencies
        const optionalDependencies: Record<string, string> = {};
        if (pkg.dependencies) {
            for (const dep of pkg.dependencies) {
                const [name, versionRange] = convertDependencyToNpm(dep, npmScope);
                optionalDependencies[name] = versionRange;
            }
        }

        // Build keywords
        const keywords = [
            'sfpm',
            'salesforce',
            String(pkg.type),
            ...(additionalKeywords || [])
        ];

        // Construct package.json
        const packageJson: NpmPackageJson = {
            name: `${npmScope}/${pkg.packageName}`,
            version: this.packageVersionNumber,
            description: pkg.packageDefinition?.versionDescription || `SFPM ${pkg.type} package: ${pkg.packageName}`,
            main: 'index.js',
            keywords,
            license: license || 'UNLICENSED',
            files: [
                'force-app/**',
                'scripts/**',
                'manifest/**',
                'config/**',
                'sfdx-project.json',
                '.forceignore',
                'changelog.json'
            ],
            sfpm: sfpmMeta,
        };

        // Add optional fields
        if (author) {
            packageJson.author = author;
        }

        if (Object.keys(optionalDependencies).length > 0) {
            packageJson.optionalDependencies = optionalDependencies;
        }

        // Add repository if available
        if (pkg.metadata?.source?.repositoryUrl) {
            packageJson.repository = {
                type: 'git',
                url: pkg.metadata.source.repositoryUrl
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
        const changelog = await this.changelogProvider.generateChangelog(
            this.sfpmPackage, 
            this.projectDirectory
        );
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
            return tarballName;

        } catch (error) {
            throw new ArtifactError(
                this.sfpmPackage.packageName,
                'pack',
                'npm pack failed',
                {
                    version: this.packageVersionNumber,
                    context: { stagingDir },
                    cause: error instanceof Error ? error : new Error(String(error))
                }
            );
        }
    }

    /**
     * Move the tarball from staging to the version directory.
     */
    private async moveTarball(stagingDir: string, tarballName: string): Promise<string> {
        const sourcePath = path.join(stagingDir, tarballName);
        const targetPath = this.repository.getArtifactTgzPath(
            this.sfpmPackage.packageName,
            this.packageVersionNumber
        );

        // Ensure version directory exists
        await fs.ensureDir(path.dirname(targetPath));

        // Move the tarball
        await fs.move(sourcePath, targetPath, { overwrite: true });
        this.logger?.debug(`Moved tarball to ${targetPath}`);

        return targetPath;
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
