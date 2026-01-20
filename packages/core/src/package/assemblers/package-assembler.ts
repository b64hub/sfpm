import ProjectConfig from '../../project/project-config.js';
import * as fs from 'fs-extra';
import path from 'path';
import crypto from 'crypto';

import { Logger } from '../../types/logger.js';
import { PackageDefinition } from '../../project/types.js';

const DOT_FOLDER = ".sfpm";

/**
 * Assembles package contents from a project configuration in a fluent, instance-based manner.
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
     * Sets the package version number to be injected into the assembly's sfdx-project.json.
     * 
     * @param version The version string (e.g., "1.2.0.1" or "1.2.0.NEXT").
     * @returns The PackageAssembler instance for chaining.
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
     * Specifies the path to an organization definition file (e.g., scratch org definition)
     * to be included in the package assembly.
     * 
     * @param path Relative or absolute path to the org definition JSON.
     * @returns The PackageAssembler instance for chaining.
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
     * Specifies the path to a destructive changes manifest (e.g., destructiveChanges.xml)
     * to be included in the package assembly.
     * 
     * @param path Relative or absolute path to the destructive changes manifest.
     * @returns The PackageAssembler instance for chaining.
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
     * Overrides the default .forceignore file with a specific replacement file.
     * 
     * @param path Relative or absolute path to the replacement .forceignore file.
     * @returns The PackageAssembler instance for chaining.
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
     * Orchestrates the package assembly process. This method executes all necessary file I/O operations,
     * including copying source code, handling scripts, generating manifests, and managing
     * the staging area lifecycle.
     * 
     * @returns A promise that resolves to the absolute path of the created staging directory.
     * @throws Error if any step of the assembly process fails.
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

    private initializeStagingArea(): string {
        const buildName = this.createBuildName();
        return path.join(process.cwd(), DOT_FOLDER, 'tmp', 'builds', buildName);
    }

    private async ensureStagingDirectoryExists(): Promise<void> {
        await fs.ensureDir(path.dirname(this.stagingDirectory));
        await fs.emptyDir(this.stagingDirectory);
    }

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

    private async copyScript(scriptsDir: string, scriptPath: string, scriptLabel: string): Promise<void> {
        const resolvedPath = path.isAbsolute(scriptPath)
            ? scriptPath
            : path.join(this.projectConfig.projectDirectory, scriptPath);

        if (!(await fs.pathExists(resolvedPath))) {
            throw new Error(`${scriptLabel}Script ${resolvedPath} does not exist`);
        }

        await fs.copy(resolvedPath, path.join(scriptsDir, scriptLabel));
    }

    private async assembleForceIgnores() {
        const forceIgnoresDir = path.join(this.stagingDirectory, 'forceignores');
        await fs.ensureDir(forceIgnoresDir);

        const projectDef = this.projectConfig.getProjectDefinition();

        const rootForceIgnore = path.join(this.projectConfig.projectDirectory, '.forceignore');
        const ignoreFiles = projectDef.plugins?.sfpm?.ignoreFiles;

        await this.assembleStageIgnoreFiles(forceIgnoresDir, ignoreFiles, rootForceIgnore);
        await this.assembleRootForceIgnore(rootForceIgnore);
    }

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
                package: 'unpackagedMetadata', // Required by our type
                versionNumber: '0.1.0.NEXT', // Required by our type
                default: false
            } as PackageDefinition);
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
