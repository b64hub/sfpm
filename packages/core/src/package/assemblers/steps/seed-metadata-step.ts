import fs from 'fs-extra';
import path from 'node:path';

import type {ProjectDefinitionProvider} from '../../../project/providers/project-definition-provider.js';

import {Logger} from '../../../types/logger.js';
import {AssemblyOptions, AssemblyOutput, AssemblyStep} from '../types.js';

/**
 * @description Copies seed metadata defined in `seedMetadata` to staging.
 *
 * Follows the same pattern as {@link UnpackagedMetadataStep}: the source path
 * is resolved relative to the project root (so it can reference directories in
 * other packages), then copied into `<staging>/seedMetadata/` where the
 * {@link ProjectJsonAssemblyStep} rewrites the path to an absolute reference.
 */
export class SeedMetadataStep implements AssemblyStep {
  constructor(
    private packageName: string,
    private provider: ProjectDefinitionProvider,
    private logger?: Logger,
  ) { }

  public async execute(_options: AssemblyOptions, output: AssemblyOutput): Promise<void> {
    const packageDefinition = this.provider.getPackageDefinition(this.packageName);

    if (!packageDefinition.seedMetadata?.path) {
      return;
    }

    const sourcePath = path.join(this.provider.projectDir, packageDefinition.seedMetadata.path);

    try {
      if (await fs.pathExists(sourcePath)) {
        const destPath = path.join(output.stagingDirectory, 'seedMetadata');
        await fs.ensureDir(destPath);
        await fs.copy(sourcePath, destPath);
        this.logger?.debug(`Copied seedMetadata from ${sourcePath} to ${destPath}`);
      } else {
        throw new Error(`seedMetadata ${packageDefinition.seedMetadata.path} does not exist`);
      }
    } catch (error: any) {
      throw new Error(`[SeedMetadataStep] ${error.message}`);
    }
  }
}
