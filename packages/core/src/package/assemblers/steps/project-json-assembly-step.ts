import {ComponentSet} from '@salesforce/source-deploy-retrieve';
import fs from 'fs-extra';
import path from 'node:path';

import type {WorkspacePackageJson} from '../../../types/workspace.js';

import {collectPackageAliases, toPackageDefinition} from '../../../project/package-json-adapter.js';
import ProjectConfig from '../../../project/project-config.js';
import {Logger} from '../../../types/logger.js';
import {PackageDefinition, ProjectDefinition} from '../../../types/project.js';
import {AssemblyOptions, AssemblyOutput, AssemblyStep} from '../types.js';

/**
 * @description Finalizes the assembly process by generating a pruned `sfdx-project.json`
 * specifically tailored for the current package.
 *
 * Supports two modes:
 * - **Workspace mode** (package.json-first): Builds sfdx-project.json from the package's
 *   own workspace package.json using `toPackageDefinition()`.
 * - **Legacy mode**: Prunes the project-level sfdx-project.json via `getPrunedDefinition()`.
 *
 * It also:
 * 1. Injects the provided version number.
 * 2. Updates paths to reference the staging area structure.
 * 3. Archives the original project manifest for reference.
 */
export class ProjectJsonAssemblyStep implements AssemblyStep {
  constructor(
    private packageName: string,
    private projectConfig: ProjectConfig,
    private logger?: Logger,
  ) { }

  public async execute(options: AssemblyOptions, output: AssemblyOutput): Promise<void> {
    try {
      const prunedManifest = options.workspacePackageJson
        ? this.buildFromWorkspacePackageJson(options.workspacePackageJson)
        : this.projectConfig.getPrunedDefinition(this.packageName);

      if (options.versionNumber) {
        (prunedManifest.packageDirectories[0] as PackageDefinition).versionNumber = options.versionNumber;
      }

      const pkg = prunedManifest.packageDirectories[0] as PackageDefinition;

      // Rewrite supplemental metadata paths relative to sfdx-project.json (staging root)
      const unpackagedMetadataDir = path.join(output.stagingDirectory, 'unpackagedMetadata');
      if (await fs.pathExists(unpackagedMetadataDir)) {
        pkg.unpackagedMetadata = {path: 'unpackagedMetadata'};
      }

      const seedMetadataDir = path.join(output.stagingDirectory, 'seedMetadata');
      if (await fs.pathExists(seedMetadataDir)) {
        pkg.seedMetadata = {path: 'seedMetadata'};
      }

      const projectJsonPath = path.join(output.stagingDirectory, 'sfdx-project.json');
      await fs.writeJson(projectJsonPath, prunedManifest, {spaces: 4});
      output.projectDefinitionPath = projectJsonPath;

      // Count components now that the full staging directory structure is complete
      const componentSet = await ComponentSet.fromSource(output.stagingDirectory);
      output.componentCount = componentSet.size;

      const manifestsDir = path.join(output.stagingDirectory, 'manifests');
      await fs.ensureDir(manifestsDir);
      await fs.copy(
        path.join(this.projectConfig.projectDirectory, 'sfdx-project.json'),
        path.join(manifestsDir, 'sfdx-project.json.original'),
      );
    } catch (error) {
      throw new Error(`[ProjectJsonAssemblyStep] ${(error as Error).message}`);
    }
  }

  /**
   * Build a single-package sfdx-project.json from a workspace package.json.
   * Uses toPackageDefinition() for the package directory entry and pulls
   * project-level settings (namespace, sourceApiVersion, packageAliases) from
   * the existing ProjectConfig.
   */
  private buildFromWorkspacePackageJson(pkgJson: WorkspacePackageJson): ProjectDefinition {
    this.logger?.debug(`Building sfdx-project.json from workspace package.json for ${this.packageName}`);

    // Get the package's directory relative to project root from ProjectConfig
    const existingDef = this.projectConfig.getPackageDefinition(this.packageName);

    // When sfpm.path is omitted (defaults to "."), the packageDir IS the source path.
    // When sfpm.path is a subdirectory (e.g., "force-app"), derive the packageDir from the parent.
    const sfpmPath = pkgJson.sfpm.path ?? '.';
    const pkgDirForAdapter = sfpmPath === '.'
      ? existingDef.path
      : path.dirname(existingDef.path) === '.' ? existingDef.path : path.dirname(existingDef.path);

    // Build workspace version map from this package's dependencies
    // (we don't have all workspace package.json files here, but we can
    // use ProjectConfig's aliases for dep resolution)
    const definition = toPackageDefinition(pkgJson, pkgDirForAdapter);
    definition.default = true;

    // Collect managed dependency aliases from this package
    const aliases: Record<string, string> = {};
    if (pkgJson.sfpm.managedDependencies) {
      for (const [alias, versionId] of Object.entries(pkgJson.sfpm.managedDependencies)) {
        aliases[alias] = versionId;
      }
    }

    // Add the package's own 0Ho ID if available
    if (pkgJson.sfpm.packageId) {
      aliases[this.packageName] = pkgJson.sfpm.packageId;
    }

    // Pull project-level aliases from ProjectConfig for dependency resolution
    // (dependencies may reference other workspace packages by their 0Ho ID)
    const projectAliases = this.projectConfig.getProjectDefinition().packageAliases ?? {};
    if (definition.dependencies) {
      for (const dep of definition.dependencies as Array<{package: string}>) {
        const alias = projectAliases[dep.package];
        if (alias && !aliases[dep.package]) {
          aliases[dep.package] = alias as string;
        }
      }
    }

    // Build the project definition with project-level settings from ProjectConfig
    const projectDef = this.projectConfig.getProjectDefinition();

    return {
      namespace: (projectDef as any).namespace ?? '',
      packageAliases: Object.keys(aliases).length > 0 ? aliases : undefined,
      packageDirectories: [definition],
      sfdcLoginUrl: (projectDef as any).sfdcLoginUrl ?? 'https://login.salesforce.com',
      ...(projectDef.sourceApiVersion ? {sourceApiVersion: projectDef.sourceApiVersion} : {}),
    } as ProjectDefinition;
  }
}
