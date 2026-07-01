import fs from 'fs-extra';
import path from 'node:path';

import type {ProjectDefinitionProvider} from '../../../project/providers/project-definition-provider.js';

import Logger from '../../../types/logger.js';
import {AssemblyOptions, AssemblyOutput, AssemblyStep} from '../types.js';

/**
 * Copies the .forceignore file into the staging directory.
 *
 * Uses `options.replacementForceignorePath` if set, otherwise falls back
 * to the root `.forceignore` from the project directory.
 */
export class ForceIgnoreStep implements AssemblyStep {
  constructor(
    private readonly packageName: string,
    private readonly provider: ProjectDefinitionProvider,
    private readonly logger?: Logger,
  ) {}

  public async execute(options: AssemblyOptions, output: AssemblyOutput): Promise<void> {
    const destPath = path.join(output.stagingDirectory, '.forceignore');

    // Use explicit replacement if provided
    if (options.replacementForceignorePath) {
      if (await fs.pathExists(options.replacementForceignorePath)) {
        await fs.copy(options.replacementForceignorePath, destPath);
        return;
      }

      this.logger?.info(`${options.replacementForceignorePath} does not exist. Using root .forceignore.`);
    }

    // Fall back to project root .forceignore
    const rootForceIgnore = path.join(this.provider.projectDir, '.forceignore');
    if (await fs.pathExists(rootForceIgnore)) {
      await fs.copy(rootForceIgnore, destPath);
    }
  }
}
