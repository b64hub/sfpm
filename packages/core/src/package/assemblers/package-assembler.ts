import ProjectConfig from '../../project/project-config.js';
import * as fs from 'fs-extra';
import path from 'path';
import crypto from 'crypto';

import { Logger } from '../../types/logger.js';
import { PackageDefinition } from '../../project/types.js';
import { PackageType } from '../../types/package.js';

const DOT_FOLDER = ".sfpm";

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
        projectConfig: ProjectConfig,
        packageName: string,
        logger?: Logger
    ) {
        this.projectConfig = projectConfig;
        this.packageName = packageName;
        this.logger = logger;
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

            const projectDirectory = this.projectConfig.projectDirectory;
            const packageDefinition = this.projectConfig.getPackageDefinition(this.packageName);
            const packagePath = packageDefinition.path;

            await fs.copy(
                path.join(projectDirectory, packagePath),
                path.join(this.stagingDirectory, packagePath)
            );

            await this.assembleUnpackagedMetadata();
            await this.assembleScripts(packageDefinition.preDeploymentScript, packageDefinition.postDeploymentScript);
            await this.assembleForceIgnores();
            await this.assembleDestructiveManifest();
            await this.assembleOrgDefinition();
            await this.assembleProjectJson();

            return this.stagingDirectory;
        } catch (error) {
            // Error Handling: attempt to delete the stagingDirectory before re-throwing
            if (process.env.DEBUG !== 'true' && this.stagingDirectory) {
                await fs.remove(this.stagingDirectory).catch(() => { });
            }
            throw error;
        }
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

    /**
     * @description Copies supplemental metadata defined in `unpackagedMetadata` to a dedicated
     * folder in the staging area. This metadata is often used for pre/post-requisites
     * that shouldn't be part of the main package installation.
     * 
     * @returns {Promise<void>}
     */
    private async assembleUnpackagedMetadata() {
        const packageDefinition = this.projectConfig.getPackageDefinition(this.packageName);

        if (!packageDefinition.unpackagedMetadata?.path) {
            return;
        }

        const sourcePath = path.join(this.projectConfig.projectDirectory, packageDefinition.unpackagedMetadata.path);
        if (await fs.pathExists(sourcePath)) {
            const destPath = path.join(this.stagingDirectory, 'unpackagedMetadata');
            await fs.ensureDir(destPath);
            await fs.copy(sourcePath, destPath);
        } else {
            throw new Error(`unpackagedMetadata ${packageDefinition.unpackagedMetadata.path} does not exist`);
        }
    }

    /**
     * @description Copies pre and post-deployment scripts to the `/scripts` subdirectory in the staging area.
     * Labels them as 'preDeployment' and 'postDeployment' for standardized discovery.
     * 
     * @param {string} [preDeploymentScript] Path to the pre-deployment script.
     * @param {string} [postDeploymentScript] Path to the post-deployment script.
     * @returns {Promise<void>}
     */
    private async assembleScripts(preDeploymentScript?: string, postDeploymentScript?: string) {
        const scriptsDir = path.join(this.stagingDirectory, 'scripts');
        await fs.ensureDir(scriptsDir);

        if (preDeploymentScript) {
            await this.copyScript(scriptsDir, preDeploymentScript, 'preDeployment');
        }

        if (postDeploymentScript) {
            await this.copyScript(scriptsDir, postDeploymentScript, 'postDeployment');
        }
    }

    /**
     * @description Internal helper to copy a single script file to the staging scripts directory.
     * Resolves path relative to project root if not absolute.
     * 
     * @param {string} scriptsDir The target scripts directory in staging.
     * @param {string} scriptPath The source path of the script.
     * @param {string} scriptLabel The label (e.g., 'preDeployment') to use in the destination.
     * @returns {Promise<void>}
     */
    private async copyScript(scriptsDir: string, scriptPath: string, scriptLabel: string): Promise<void> {
        const resolvedPath = path.isAbsolute(scriptPath)
            ? scriptPath
            : path.join(this.projectConfig.projectDirectory, scriptPath);

        if (!(await fs.pathExists(resolvedPath))) {
            throw new Error(`${scriptLabel}Script ${resolvedPath} does not exist`);
        }

        await fs.copy(resolvedPath, path.join(scriptsDir, scriptLabel));
    }

    /**
     * @description Manages the assembly of ignore files. This includes:
     * 1. Setting up stage-specific ignore files (prepare, validate, etc.) in the `/forceignores` directory.
     * 2. Setting up the root `.forceignore` file for the staging area.
     * 
     * @returns {Promise<void>}
     */
    private async assembleForceIgnores() {
        const forceIgnoresDir = path.join(this.stagingDirectory, 'forceignores');
        await fs.ensureDir(forceIgnoresDir);

        const projectDef = this.projectConfig.getProjectDefinition();

        const rootForceIgnore = path.join(this.projectConfig.projectDirectory, '.forceignore');
        const ignoreFiles = projectDef.plugins?.sfpm?.ignoreFiles;

        await this.assembleStageIgnoreFiles(forceIgnoresDir, ignoreFiles, rootForceIgnore);
        await this.assembleRootForceIgnore(rootForceIgnore);
    }

    /**
     * @description Iterates through standardized deployment stages and prepares unique ignore files 
     * for each. These allow fine-grained control over what is filtered during 
     * different parts of the CI/CD pipeline.
     * 
     * @param {string} forceIgnoresDir The directory where stage-specific ignore files are stored.
     * @param {any} ignoreFiles Configuration object containing stage-to-path mappings.
     * @param {string} rootForceIgnore The path to the root .forceignore file.
     * @returns {Promise<void>}
     */
    private async assembleStageIgnoreFiles(
        forceIgnoresDir: string,
        ignoreFiles: any,
        rootForceIgnore: string
    ) {
        const stages = ['prepare', 'validate', 'quickbuild', 'build'];
        for (const stage of stages) {
            await this.copyIgnoreFileForStage(forceIgnoresDir, stage, ignoreFiles?.[stage], rootForceIgnore);
        }
    }

    /**
     * @description Logic for selecting and preparing a specific stage's ignore file.
     * Hierarchy of selection:
     * 1. Path explicitly defined in `plugins.sfpm.ignoreFiles[stage]`
     * 2. Fallback to `forceignores/.[stage]ignore` in the project root.
     * 3. Fallback to the root `.forceignore` if neither of the above exist.
     * 
     * All resulting stage ignore files are appended with `postDeploy` to ensure 
     * deployment-only metadata is ignored during validation stages if desired.
     * 
     * @param {string} forceIgnoresDir The destination directory.
     * @param {string} stage The deployment stage (e.g., 'prepare').
     * @param {string | undefined} stageSpecificIgnorePath Explicitly configured path for the stage.
     * @param {string} rootForceIgnore Path to the root .forceignore file.
     * @returns {Promise<void>}
     */
    private async copyIgnoreFileForStage(
        forceIgnoresDir: string,
        stage: string,
        stageSpecificIgnorePath: string | undefined,
        rootForceIgnore: string
    ) {
        const destIgnorePath = path.join(forceIgnoresDir, `.${stage}ignore`);

        if (stageSpecificIgnorePath) {
            const resolvedStageIgnorePath = path.join(this.projectConfig.projectDirectory, stageSpecificIgnorePath);

            if (await fs.pathExists(resolvedStageIgnorePath)) {
                await fs.copy(resolvedStageIgnorePath, destIgnorePath);

            } else if (await fs.pathExists(path.join(this.projectConfig.projectDirectory, 'forceignores', `.${stage}ignore`))) {
                await fs.copy(path.join(this.projectConfig.projectDirectory, 'forceignores', `.${stage}ignore`), destIgnorePath);

            } else {
                throw new Error(`${resolvedStageIgnorePath} does not exist`);
            }

        } else if (await fs.pathExists(rootForceIgnore)) {
            await fs.copy(rootForceIgnore, destIgnorePath);
        }

        if (await fs.pathExists(destIgnorePath)) {
            await fs.appendFile(destIgnorePath, "\n**/postDeploy");
        }
    }

    /**
     * @description Sets up the root `.forceignore` for the staging area.
     * If a replacement path was provided via `withReplacementForceIgnore`, it is used;
     * otherwise, it falls back to the project's root `.forceignore`.
     * 
     * @param {string} rootForceIgnore Path to the project's root .forceignore file.
     * @returns {Promise<void>}
     */
    private async assembleRootForceIgnore(rootForceIgnore: string) {
        const destPath = path.join(this.stagingDirectory, '.forceignore');

        if (this.pathToReplacementForceIgnore) {
            if (await fs.pathExists(this.pathToReplacementForceIgnore)) {
                await fs.copy(this.pathToReplacementForceIgnore, destPath);
                return;
            }
            this.logger?.info(`${this.pathToReplacementForceIgnore} does not exist. Using root .forceignore.`);
        }

        if (await fs.pathExists(rootForceIgnore)) {
            await fs.copy(rootForceIgnore, destPath);
        }
    }

    /**
     * @description If a destructive manifest was provided, copies it to the `/destructive` 
     * directory in the staging area, renaming it to `destructiveChanges.xml` for 
     * standardized metadata API deployments.
     * 
     * @returns {Promise<void>}
     */
    private async assembleDestructiveManifest() {
        if (!this.destructiveManifestFilePath) {
            return;
        }

        const sourcePath = path.isAbsolute(this.destructiveManifestFilePath)
            ? this.destructiveManifestFilePath
            : path.join(this.projectConfig.projectDirectory, this.destructiveManifestFilePath);

        if (!(await fs.pathExists(sourcePath))) {
            this.logger?.warn(`Destructive manifest ${sourcePath} not found.`);
            return;
        }

        const destDir = path.join(this.stagingDirectory, 'destructive');
        await fs.ensureDir(destDir);
        await fs.copy(sourcePath, path.join(destDir, 'destructiveChanges.xml'));
    }

    /**
     * @description If an organization definition (e.g., scratch org config) was provided, 
     * copies it to the `/config` directory in the staging area as `project-scratch-def.json`.
     * 
     * @returns {Promise<void>}
     */
    private async assembleOrgDefinition() {
        if (!this.orgDefinitionFilePath) {
            return;
        }

        const sourcePath = path.isAbsolute(this.orgDefinitionFilePath)
            ? this.orgDefinitionFilePath
            : path.join(this.projectConfig.projectDirectory, this.orgDefinitionFilePath);

        if (!(await fs.pathExists(sourcePath))) {
            this.logger?.warn(`Config file ${sourcePath} not found.`);
            return;
        }

        const destDir = path.join(this.stagingDirectory, 'config');
        await fs.ensureDir(destDir);
        await fs.copy(sourcePath, path.join(destDir, 'project-scratch-def.json'));
    }

    /**
     * @description Finalizes the assembly by:
     * 1. Generating a pruned `sfdx-project.json` containing only this package.
     * 2. Updating paths within that manifest to be relative to the staging root.
     * 3. Injecting the specified version number.
     * 4. Archiving the original `sfdx-project.json` for reference.
     * 
     * @returns {Promise<void>}
     */
    private async assembleProjectJson() {
        const prunedManifest = this.projectConfig.getPrunedDefinition(this.packageName);

        // Inject the versionNumber if provided
        if (this.versionNumber) {
            prunedManifest.packageDirectories[0].versionNumber = this.versionNumber;
        }

        // Update paths to be relative to the artifact root
        if (await fs.pathExists(path.join(this.stagingDirectory, 'unpackagedMetadata'))) {

            (prunedManifest.packageDirectories[0] as PackageDefinition).unpackagedMetadata = { path: 'unpackagedMetadata' };
            prunedManifest.packageDirectories.push({
                path: 'unpackagedMetadata',
                package: 'unpackagedMetadata',
                versionNumber: '0.0.0.0',
                type: PackageType.Source,
                default: false
            });
        }

        if (await fs.pathExists(path.join(this.stagingDirectory, 'scripts', 'preDeployment'))) {
            (prunedManifest.packageDirectories[0] as PackageDefinition).preDeploymentScript = path.join('scripts', 'preDeployment');
        }

        if (await fs.pathExists(path.join(this.stagingDirectory, 'scripts', 'postDeployment'))) {
            (prunedManifest.packageDirectories[0] as PackageDefinition).postDeploymentScript = path.join('scripts', 'postDeployment');
        }

        await fs.writeJSON(path.join(this.stagingDirectory, 'sfdx-project.json'), prunedManifest, { spaces: 4 });

        const manifestsDir = path.join(this.stagingDirectory, 'manifests');
        await fs.ensureDir(manifestsDir);
        await fs.copy(
            path.join(this.projectConfig.projectDirectory, 'sfdx-project.json'),
            path.join(manifestsDir, 'sfdx-project.json.original')
        );
    }
}
