import { AssemblyStep, AssemblyOptions, AssemblyOutput } from "../types.js";
import { Logger } from "../../../types/logger.js";
import { IgnoreFilesConfig } from "../../../types/config.js";
import ProjectConfig from "../../../project/project-config.js";
import fs from 'fs-extra';
import path from 'path';

/**
 * @description Manages the assembly of ignore files for the package.
 * It handles both stage-specific ignore files (prepare, validate, etc.) and the root .forceignore.
 */
export class ForceIgnoreStep implements AssemblyStep {
    constructor(
        private packageName: string,
        private projectConfig: ProjectConfig,
        private logger?: Logger
    ) { }

    public async execute(options: AssemblyOptions, output: AssemblyOutput): Promise<void> {
        const forceIgnoresDir = path.join(output.stagingDirectory, 'forceignores');
        await fs.ensureDir(forceIgnoresDir);

        const rootForceIgnore = path.join(this.projectConfig.projectDirectory, '.forceignore');
        const ignoreFilesConfig = options.ignoreFilesConfig;

        try {
            await this.assembleStageIgnoreFiles(options, forceIgnoresDir, ignoreFilesConfig, rootForceIgnore);
            await this.assembleRootForceIgnore(options, output.stagingDirectory, rootForceIgnore);
        } catch (error: any) {
            throw new Error(`[ForceIgnoreStep] ${error.message}`);
        }
    }

    private async assembleStageIgnoreFiles(
        options: AssemblyOptions,
        forceIgnoresDir: string,
        ignoreFilesConfig: IgnoreFilesConfig | undefined,
        rootForceIgnore: string
    ) {
        // Infer stages from the config keys — no hardcoded stage list
        if (!ignoreFilesConfig) {
            return;
        }

        const stages = Object.keys(ignoreFilesConfig) as (keyof IgnoreFilesConfig)[];
        for (const stage of stages) {
            const stageIgnorePath = ignoreFilesConfig[stage];
            if (stageIgnorePath) {
                await this.copyIgnoreFileForStage(forceIgnoresDir, stage, stageIgnorePath, rootForceIgnore);
            }
        }
    }

    private async copyIgnoreFileForStage(
        forceIgnoresDir: string,
        stage: string,
        stageSpecificIgnorePath: string | undefined,
        rootForceIgnore: string
    ) {
        const destIgnorePath = path.join(forceIgnoresDir, `.forceignore.${stage}`);

        if (stageSpecificIgnorePath) {
            const resolvedStageIgnorePath = path.join(this.projectConfig.projectDirectory, stageSpecificIgnorePath);

            if (await fs.pathExists(resolvedStageIgnorePath)) {
                await fs.copy(resolvedStageIgnorePath, destIgnorePath);
            // eslint-disable-next-line no-await-in-loop -- we want to check for each stage-specific file sequentially
            } else if (await fs.pathExists(path.join(this.projectConfig.projectDirectory, 'forceignores', `.forceignore.${stage}`))) {
                // Fallback: check forceignores/ directory for convention-based file
                await fs.copy(path.join(this.projectConfig.projectDirectory, 'forceignores', `.forceignore.${stage}`), destIgnorePath);
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
            this.logger?.info(`${options.replacementForceignorePath} does not exist. Using root .forceignore.`);
        }

        if (await fs.pathExists(rootForceIgnore)) {
            await fs.copy(rootForceIgnore, destPath);
        }
    }
}
