import { AssemblyStep, AssemblyOptions } from "../types.js";
import * as fs from 'fs-extra';
import path from 'path';

/**
 * @description Manages the assembly of ignore files for the package.
 * It handles both stage-specific ignore files (prepare, validate, etc.) and the root .forceignore.
 */
export class ForceIgnoreStep implements AssemblyStep {
    /**
     * @description Orchestrates the gathering and copying of all necessary ignore files.
     * @param options Shared assembly configuration.
     * @param stagingDirectory The target directory for assembly.
     * @throws {Error} If any part of the ignore file assembly fails.
     */
    public async execute(options: AssemblyOptions, stagingDirectory: string): Promise<void> {
        const forceIgnoresDir = path.join(stagingDirectory, 'forceignores');
        await fs.ensureDir(forceIgnoresDir);

        const projectDef = options.projectConfig.getProjectDefinition();
        const rootForceIgnore = path.join(options.projectConfig.projectDirectory, '.forceignore');
        const ignoreFilesConfig = projectDef.plugins?.sfpm?.ignoreFiles;

        try {
            await this.assembleStageIgnoreFiles(options, forceIgnoresDir, ignoreFilesConfig, rootForceIgnore);
            await this.assembleRootForceIgnore(options, stagingDirectory, rootForceIgnore);
        } catch (error: any) {
            throw new Error(`[ForceIgnoreStep] ${error.message}`);
        }
    }

    private async assembleStageIgnoreFiles(
        options: AssemblyOptions,
        forceIgnoresDir: string,
        ignoreFilesConfig: any,
        rootForceIgnore: string
    ) {
        const stages = ['prepare', 'validate', 'quickbuild', 'build'];
        for (const stage of stages) {
            await this.copyIgnoreFileForStage(options, forceIgnoresDir, stage, ignoreFilesConfig?.[stage], rootForceIgnore);
        }
    }

    private async copyIgnoreFileForStage(
        options: AssemblyOptions,
        forceIgnoresDir: string,
        stage: string,
        stageSpecificIgnorePath: string | undefined,
        rootForceIgnore: string
    ) {
        const destIgnorePath = path.join(forceIgnoresDir, `.${stage}ignore`);

        if (stageSpecificIgnorePath) {
            const resolvedStageIgnorePath = path.join(options.projectConfig.projectDirectory, stageSpecificIgnorePath);

            if (await fs.pathExists(resolvedStageIgnorePath)) {
                await fs.copy(resolvedStageIgnorePath, destIgnorePath);
            } else if (await fs.pathExists(path.join(options.projectConfig.projectDirectory, 'forceignores', `.${stage}ignore`))) {
                await fs.copy(path.join(options.projectConfig.projectDirectory, 'forceignores', `.${stage}ignore`), destIgnorePath);
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

    private async assembleRootForceIgnore(options: AssemblyOptions, stagingDirectory: string, rootForceIgnore: string) {
        const destPath = path.join(stagingDirectory, '.forceignore');

        if (options.replacementForceignorePath) {
            if (await fs.pathExists(options.replacementForceignorePath)) {
                await fs.copy(options.replacementForceignorePath, destPath);
                return;
            }
            options.logger?.info(`${options.replacementForceignorePath} does not exist. Using root .forceignore.`);
        }

        if (await fs.pathExists(rootForceIgnore)) {
            await fs.copy(rootForceIgnore, destPath);
        }
    }
}
