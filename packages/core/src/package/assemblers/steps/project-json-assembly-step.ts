import {ComponentSet} from '@salesforce/source-deploy-retrieve';
import fg from 'fast-glob';
import fs from 'fs-extra';
import path from 'node:path';

import type {ProjectDefinitionProvider} from '../../../project/providers/project-definition-provider.js';

import ProjectService from '../../../project/project-service.js';
import {Logger} from '../../../types/logger.js';
import {PackageType} from '../../../types/package.js';
import {PackageDefinition} from '../../../types/project.js';
import {toVersionFormat} from '../../../utils/version-utils.js';
import {AssemblyOptions, AssemblyOutput, AssemblyStep} from '../types.js';

/**
 * @description Finalizes the assembly process by generating a single-package `sfdx-project.json`
 * specifically tailored for the current package.
 *
 * Delegates to `ProjectService.resolveForPackage()` which uses the appropriate
 * ProjectDefinitionProvider:
 * - **Workspace mode**: builds from the package's own workspace package.json
 * - **Legacy mode**: prunes the full sfdx-project.json
 *
 * It also:
 * 1. Injects the provided version number.
 * 2. Rewrites supplemental metadata paths relative to the staging root
 *    (i.e. relative to sfdx-project.json).
 * 3. Archives the original project manifest for reference.
 */
export class ProjectJsonAssemblyStep implements AssemblyStep {
  constructor(
    private packageName: string,
    private provider: ProjectDefinitionProvider,
    private logger?: Logger,
  ) { }

  public async execute(options: AssemblyOptions, output: AssemblyOutput): Promise<void> {
    try {
      const packageDefinition = this.provider.resolveForPackage(this.packageName);

      if (options.versionNumber) {
        (packageDefinition.packageDirectories[0] as PackageDefinition).versionNumber = toVersionFormat(options.versionNumber, 'salesforce');
      }

      const pkg = packageDefinition.packageDirectories[0] as PackageDefinition;

      output.projectDefinitionPath = await this.writeProjectDefinition(packageDefinition, pkg, output.stagingDirectory);
      output.componentCount = await this.countComponents(pkg.type || PackageType.Managed, output.stagingDirectory);

      const manifestsDir = path.join(output.stagingDirectory, 'manifests');
      await fs.ensureDir(manifestsDir);
      await fs.copy(
        path.join(this.provider.projectDir, 'sfdx-project.json'),
        path.join(manifestsDir, 'sfdx-project.json.original'),
      );
    } catch (error) {
      throw new Error(`[ProjectJsonAssemblyStep] ${(error as Error).message}`);
    }
  }

  /**
   * Count components now that the full staging directory structure is complete.
   * Data packages contain data files (CSV, JSON) rather than Salesforce metadata,
   * so ComponentSet would report 0. Count actual files instead.
   */
  private async countComponents(packageType: PackageType, stagingDir: string): Promise<number> {
    if (packageType === PackageType.Data) {
      const files = await fg(['**/*'], {
        cwd: stagingDir, dot: false, ignore: ['sfdx-project.json', 'manifests/**'], onlyFiles: true,
      });
      return files.length;
    }

    const componentSet = await ComponentSet.fromSource(stagingDir);
    return componentSet.size;
  }

  /**
   * Rewrite supplemental metadata paths relative to the staging root
   * (where sfdx-project.json lives) and write the full project definition.
   *
   * @returns path to the staged sfdx-project.json
   */
  private async writeProjectDefinition(
    packageDefinition: ReturnType<ProjectDefinitionProvider['resolveForPackage']>,
    pkg: PackageDefinition,
    stagingDir: string,
  ): Promise<string> {
    const unpackagedMetadataDir = path.join(stagingDir, 'unpackagedMetadata');
    if (await fs.pathExists(unpackagedMetadataDir)) {
      pkg.unpackagedMetadata = {path: 'unpackagedMetadata'};
    }

    const seedMetadataDir = path.join(stagingDir, 'seedMetadata');
    if (await fs.pathExists(seedMetadataDir)) {
      pkg.seedMetadata = {path: 'seedMetadata'};
    }

    const projectJsonPath = path.join(stagingDir, 'sfdx-project.json');
    await fs.writeJson(projectJsonPath, packageDefinition, {spaces: 4});

    return projectJsonPath;
  }
}
