import * as fs from 'fs-extra';
import path from 'node:path';

import type {ProjectDefinitionProvider} from '../../../project/providers/project-definition-provider.js';

import {Logger} from '../../../types/logger.js';
import {AssemblyOptions, AssemblyOutput, AssemblyStep} from '../types.js';

/**
 * @description Copies supplemental metadata defined in `unpackagedMetadata` to staging.
 */
export class UnpackagedMetadataStep implements AssemblyStep {
  constructor(
    private packageName: string,
    private provider: ProjectDefinitionProvider,
    private logger?: Logger,
  ) { }

  public async execute(options: AssemblyOptions, output: AssemblyOutput): Promise<void> {
    const packageDefinition = this.provider.getPackageDefinition(this.packageName);
    const sourceDir = path.join(this.provider.projectDir, packageDefinition.path);
    const destinationDir = path.join(output.stagingDirectory, packageDefinition.path);

    if (!packageDefinition.unpackagedMetadata?.path) {
      return;
    }

    const sourcePath = path.join(this.provider.projectDir, packageDefinition.unpackagedMetadata.path);

    try {
      if (await fs.pathExists(sourcePath)) {
        const destPath = path.join(output.stagingDirectory, 'unpackagedMetadata');
        await fs.ensureDir(destPath);
        await fs.copy(sourcePath, destPath);
      } else {
        throw new Error(`unpackagedMetadata ${packageDefinition.unpackagedMetadata.path} does not exist`);
      }
    } catch (error: any) {
      throw new Error(`[UnpackagedMetadataStep] ${error.message}`);
    }
  }
}
