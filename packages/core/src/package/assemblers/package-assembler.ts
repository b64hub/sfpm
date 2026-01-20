import ProjectConfig from '../../project/project-config.js';
import * as fs from 'fs-extra';
import path from 'path';
import crypto from 'crypto';

import { Logger } from '../../types/logger.js';
import { PackageDefinition } from '../../project/types.js';
import { PackageType } from '../../types/package.js';
import MDAPIConverter from './mdapi-converter.js';

const DOT_FOLDER = ".sfpm";


import { AssemblyOptions, AssemblyStep } from './types.js';
import { SourceCopyStep } from './steps/source-copy-step.js';
import { UnpackagedMetadataStep } from './steps/unpackaged-metadata-step.js';
import { ScriptAssemblyStep } from './steps/script-assembly-step.js';
import { ForceIgnoreStep } from './steps/force-ignore-step.js';
import { DestructiveManifestStep } from './steps/destructive-manifest-step.js';
import { OrgDefinitionStep } from './steps/org-definition-step.js';
import { ManifestAssemblyStep } from './steps/manifest-assembly-step.js';

/**
 * @description Assembles package contents from a project configuration in a fluent, instance-based manner.
 * 
 * ### Staging Area ("The Why")
 * The `PackageAssembler` creates a temporary, isolated "staging area" for each build. This isolation:
 * 1. **Prevents Interference**: Multiple concurrent builds won't corrupt each other's files.
 * 2. **Ensures Determinism**: The resulting artifact contains exactly what is specified, with no leftover files from previous runs.
 * 3. **Simplifies Packaging**: Tools can simply zip or upload the entire contents of the staging directory.
 * 
 * ### Staging Structure ("The How")
 * The staging area follows a standardized layout:
 * - `/[packagePath]`: Primary source metadata.
 * - `/unpackagedMetadata`: Supplemental metadata not part of the main package.
 * - `/scripts`: Pre and post-deployment scripts.
 * - `/forceignores`: Stage-specific ignore files (e.g., `.prepareignore`).
 * - `.forceignore`: The root ignore file used for the final artifact.
 * - `sfdx-project.json`: A pruned version of the original manifest, specifically for this package.
 * 
 * @example
 * ```typescript
 * const stagingPath = await new PackageAssembler(projectConfig, 'my-package', logger)
 *     .withVersion('1.2.3.4')
 *     .withOrgDefinition('config/project-scratch-def.json')
 *     .assemble();
 * ```
 */
export default class PackageAssembler {
    private projectConfig: ProjectConfig;
    private packageName: string;
    private logger?: Logger;

    private stagingDirectory: string;
    private versionNumber?: string;
    private orgDefinitionFilePath?: string;
    private destructiveManifestFilePath?: string;
    private pathToReplacementForceIgnore?: string;

    constructor(
        options: AssemblyOptions
    ) {
        this.projectConfig = options.projectConfig;
        this.packageName = options.packageName;
        this.logger = options.logger;
        this.versionNumber = options.versionNumber;
        this.orgDefinitionFilePath = options.orgDefinitionPath;
        this.destructiveManifestFilePath = options.destructiveManifestPath;
        this.pathToReplacementForceIgnore = options.replacementForceignorePath;
        this.stagingDirectory = this.initializeStagingArea();
    }

    /**
     * @description Sets the package version number to be injected into the assembly's sfdx-project.json.
     * 
     * @param {string | undefined} version The version string (e.g., "1.2.0.1" or "1.2.0.NEXT").
     * @returns {this} The PackageAssembler instance for chaining.
     * 
     * @example
     * ```typescript
     * assembler.withVersion('1.0.0.NEXT');
     * ```
     */
    public withVersion(version: string | undefined): this {
        this.versionNumber = version;
        return this;
    }

    /**
     * @description Specifies the path to an organization definition file (e.g., scratch org definition)
     * to be included in the package assembly.
     * 
     * @param {string | undefined} path Relative or absolute path to the org definition JSON.
     * @returns {this} The PackageAssembler instance for chaining.
     * 
     * @example
     * ```typescript
     * assembler.withOrgDefinition('config/project-scratch-def.json');
     * ```
     */
    public withOrgDefinition(path: string | undefined): this {
        this.orgDefinitionFilePath = path;
        return this;
    }

    /**
     * @description Specifies the path to a destructive changes manifest (e.g., destructiveChanges.xml)
     * to be included in the package assembly.
     * 
     * @param {string | undefined} path Relative or absolute path to the destructive changes manifest.
     * @returns {this} The PackageAssembler instance for chaining.
     * 
     * @example
     * ```typescript
     * assembler.withDestructiveManifest('manifest/destructiveChanges.xml');
     * ```
     */
    public withDestructiveManifest(path: string | undefined): this {
        this.destructiveManifestFilePath = path;
        return this;
    }

    /**
     * @description Overrides the default .forceignore file with a specific replacement file.
     * 
     * @param {string | undefined} path Relative or absolute path to the replacement .forceignore file.
     * @returns {this} The PackageAssembler instance for chaining.
     * 
     * @example
     * ```typescript
     * assembler.withReplacementForceIgnore('.forceignore.prod');
     * ```
     */
    public withReplacementForceIgnore(path: string | undefined): this {
        this.pathToReplacementForceIgnore = path;
        return this;
    }

    /**
     * @description Orchestrates the package assembly process. This method executes all necessary file I/O operations,
     * including copying source code, handling scripts, generating manifests, and managing
     * the staging area lifecycle.
     * 
     * @returns {Promise<string>} A promise that resolves to the absolute path of the created staging directory.
     * @throws {Error} if any step of the assembly process fails.
     * 
     * @example
     * ```typescript
     * const stagingPath = await assembler.assemble();
     * console.log(`Package assembled at: ${stagingPath}`);
     * ```
     */
    public async assemble(): Promise<string> {
        try {
            await this.ensureStagingDirectoryExists();

            const steps: AssemblyStep[] = [
                new SourceCopyStep(),
                new UnpackagedMetadataStep(),
                new ScriptAssemblyStep(),
                new ForceIgnoreStep(),
                new DestructiveManifestStep(),
                new OrgDefinitionStep(),
                new ManifestAssemblyStep()
            ];

            const options = this.getAssemblyOptions();

            for (const step of steps) {
                this.logger?.debug(`Executing step: ${step.constructor.name}`);
                await step.execute(options, this.stagingDirectory);
            }

            return this.stagingDirectory;
        } catch (error) {
            // Error Handling: attempt to delete the stagingDirectory before re-throwing
            if (process.env.DEBUG !== 'true' && this.stagingDirectory) {
                await fs.remove(this.stagingDirectory).catch(() => { });
            }
            throw error;
        }
    }

    private getAssemblyOptions(): AssemblyOptions {
        return {
            projectConfig: this.projectConfig,
            packageName: this.packageName,
            logger: this.logger,
            versionNumber: this.versionNumber,
            orgDefinitionPath: this.orgDefinitionFilePath,
            destructiveManifestPath: this.destructiveManifestFilePath,
            replacementForceignorePath: this.pathToReplacementForceIgnore
        };
    }

    /**
     * @description Resolves the path for the temporary assembly area.
     * The path is constructed as: `.sfpm/tmp/builds/[timestamp]-[packageName]-[hash]`
     * 
     * @returns {string} The absolute path to the staging directory.
     */
    private initializeStagingArea(): string {
        const buildName = this.createBuildName();
        return path.join(process.cwd(), DOT_FOLDER, 'tmp', 'builds', buildName);
    }

    /**
     * @description Ensures the parent directories for the staging area exist and that the 
     * specific staging folder is completely empty and ready for a fresh build.
     * 
     * @returns {Promise<void>}
     */
    private async ensureStagingDirectoryExists(): Promise<void> {
        await fs.ensureDir(path.dirname(this.stagingDirectory));
        await fs.emptyDir(this.stagingDirectory);
    }

    /**
     * @description Generates a unique name for the build to avoid collisions.
     * Format: YYYYMMDDHHMMSS-[packageName]-[randomHash]
     * 
     * @returns {string} A unique build identifier.
     */
    private createBuildName(): string {
        const now = new Date();
        const timestamp = now.toISOString()
            .replace(/T/, '-')
            .replace(/\..+/, '')
            .replace(/:/g, '')
            .replace(/-/g, '');

        const hash = crypto.randomBytes(2).toString('hex');
        return `${timestamp}-${this.packageName}-${hash}`;
    }

}
