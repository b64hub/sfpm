import fs from 'fs-extra';
import path from 'node:path';

import type {ProjectDefinitionProvider} from '../../../project/providers/project-definition-provider.js';

import {Logger} from '../../../types/logger.js';
import {AssemblyOptions, AssemblyOutput, AssemblyStep} from '../types.js';

/**
 * Copies supplemental metadata directories (seed and unpackaged) to staging.
 *
 * Source paths come from `PackageDefinition.metadataDependencies` and are
 * resolved relative to the project root. Each directory is copied into the
 * staging area under a well-known name (`seedMetadata/`, `unpackagedMetadata/`).
 *
 * Staged paths are recorded on {@link AssemblyOutput.metadataPaths} so that
 * downstream steps (e.g. {@link ProjectJsonAssemblyStep}) can reference them
 * without re-probing the filesystem.
 */
export class MetadataDependenciesStep implements AssemblyStep {
  constructor(
    private packageName: string,
    private provider: ProjectDefinitionProvider,
    private logger?: Logger,
  ) { }

  public async execute(_options: AssemblyOptions, output: AssemblyOutput): Promise<void> {
    const packageDefinition = this.provider.getPackageDefinition(this.packageName);
    const metaDeps = packageDefinition.metadataDependencies;

    if (!metaDeps) return;

    if (metaDeps.seed) {
      await this.copyMetadata(metaDeps.seed, 'seedMetadata', 'seed', output);
    }

    if (metaDeps.unpackaged) {
      await this.copyMetadata(metaDeps.unpackaged, 'unpackagedMetadata', 'unpackaged', output);
    }
  }

  private async copyMetadata(
    relativePath: string,
    stagingDirName: string,
    outputKey: 'seed' | 'unpackaged',
    output: AssemblyOutput,
  ): Promise<void> {
    const sourcePath = path.join(this.provider.projectDir, relativePath);

    try {
      if (await fs.pathExists(sourcePath)) {
        const destPath = path.join(output.stagingDirectory, stagingDirName);
        await fs.ensureDir(destPath);
        await fs.copy(sourcePath, destPath);
        this.logger?.debug(`Copied ${outputKey} metadata from ${sourcePath} to ${destPath}`);

        output.metadataPaths ??= {};
        output.metadataPaths[outputKey] = stagingDirName;
      } else {
        throw new Error(`${outputKey} metadata path ${relativePath} does not exist`);
      }
    } catch (error: any) {
      throw new Error(`[MetadataDependenciesStep] ${error.message}`);
    }
  }
}
