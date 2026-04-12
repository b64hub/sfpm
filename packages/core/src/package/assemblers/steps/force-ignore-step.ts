import fs from 'fs-extra';
import path from 'node:path';

import type {ProjectDefinitionProvider} from '../../../project/project-definition-provider.js';

import {IgnoreFilesConfig} from '../../../types/config.js';
import {Logger} from '../../../types/logger.js';
import {AssemblyOptions, AssemblyOutput, AssemblyStep} from '../types.js';

/**
 * @description Manages the assembly of ignore files for the package.
 * It handles both stage-specific ignore files (prepare, validate, etc.) and the root .forceignore.
 */
export class ForceIgnoreStep implements AssemblyStep {
  constructor(
    private readonly packageName: string,
    private readonly provider: ProjectDefinitionProvider,
    private readonly logger?: Logger,
  ) { }

  public async execute(options: AssemblyOptions, output: AssemblyOutput): Promise<void> {
    const forceIgnoresDir = path.join(output.stagingDirectory, 'forceignores');
    await fs.ensureDir(forceIgnoresDir);

    const rootForceIgnore = path.join(this.provider.projectDir, '.forceignore');
    const {ignoreFilesConfig} = options;

    try {
      await this.assembleStageIgnoreFiles(forceIgnoresDir, ignoreFilesConfig, rootForceIgnore);
      await this.assembleRootForceIgnore(options, output.stagingDirectory, rootForceIgnore);
    } catch (error: any) {
      throw new Error(`[ForceIgnoreStep] ${error.message}`);
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

  private async assembleStageIgnoreFiles(
    forceIgnoresDir: string,
    ignoreFilesConfig: IgnoreFilesConfig | undefined,
    rootForceIgnore: string,
  ) {
    // Infer stages from the config keys — no hardcoded stage list
    if (!ignoreFilesConfig) {
      return;
    }

    const stages = Object.keys(ignoreFilesConfig) as (keyof IgnoreFilesConfig)[];
    for (const stage of stages) {
      const stageIgnorePath = ignoreFilesConfig[stage];
      if (stageIgnorePath) {
        // eslint-disable-next-line no-await-in-loop -- we want to process each stage sequentially to manage file operations
        await this.copyIgnoreFileForStage(forceIgnoresDir, stage, stageIgnorePath, rootForceIgnore);
      }
    }
  }

  private async copyIgnoreFileForStage(
    forceIgnoresDir: string,
    stage: string,
    stageSpecificIgnorePath: string | undefined,
    rootForceIgnore: string,
  ) {
    const destIgnorePath = path.join(forceIgnoresDir, `.forceignore.${stage}`);

    if (stageSpecificIgnorePath) {
      const resolvedStageIgnorePath = path.join(this.provider.projectDir, stageSpecificIgnorePath);

      if (await fs.pathExists(resolvedStageIgnorePath)) {
        await fs.copy(resolvedStageIgnorePath, destIgnorePath);
      } else if (await fs.pathExists(path.join(this.provider.projectDir, 'forceignores', `.forceignore.${stage}`))) {
        // Fallback: check forceignores/ directory for convention-based file
        await fs.copy(path.join(this.provider.projectDir, 'forceignores', `.forceignore.${stage}`), destIgnorePath);
      } else {
        throw new Error(`${resolvedStageIgnorePath} does not exist`);
      }
    } else if (await fs.pathExists(rootForceIgnore)) {
      await fs.copy(rootForceIgnore, destIgnorePath);
    }

    if (await fs.pathExists(destIgnorePath)) {
      await fs.appendFile(destIgnorePath, '\n**/postDeploy');
    }
  }
}
