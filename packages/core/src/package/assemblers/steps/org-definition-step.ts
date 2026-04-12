import * as fs from 'fs-extra';
import path from 'node:path';

import type {ProjectDefinitionProvider} from '../../../project/providers/project-definition-provider.js';

import {Logger} from '../../../types/logger.js';
import {AssemblyOptions, AssemblyOutput, AssemblyStep} from '../types.js';

/**
 * @description Handles organization definition files, typically `project-scratch-def.json`.
 * If a path is provided, it's copied to the `/config` folder in the staging area.
 */
export class OrgDefinitionStep implements AssemblyStep {
  constructor(
    private packageName: string,
    private provider: ProjectDefinitionProvider,
    private logger?: Logger,
  ) { }

  /**
   * @description Executes the organization definition assembly.
   * @param options Shared assembly configuration.
   * @param output Shared assembly output.
   * @throws {Error} If the copy operation fails.
   */
  public async execute(options: AssemblyOptions, output: AssemblyOutput): Promise<void> {
    if (!options.orgDefinitionPath) {
      return;
    }

    const sourcePath = path.isAbsolute(options.orgDefinitionPath)
      ? options.orgDefinitionPath
      : path.join(this.provider.projectDir, options.orgDefinitionPath);

    try {
      if (!(await fs.pathExists(sourcePath))) {
        this.logger?.warn(`Config file ${sourcePath} not found.`);
        return;
      }

      const destDir = path.join(output.stagingDirectory, 'config');
      await fs.ensureDir(destDir);
      await fs.copy(sourcePath, path.join(destDir, 'project-scratch-def.json'));
    } catch (error: any) {
      throw new Error(`[OrgDefinitionStep] ${error.message}`);
    }
  }
}
