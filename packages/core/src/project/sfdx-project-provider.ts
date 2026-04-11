/**
 * Legacy sfdx-project.json–based ProjectDefinitionProvider.
 *
 * Reads the project definition directly from sfdx-project.json via
 * @salesforce/core's SfProject. This is the traditional approach used
 * when no workspace configuration is detected.
 */

import {ProjectJsonSchema, SfProject} from '@salesforce/core';

import type {PackageDefinition, ProjectDefinition} from '../types/project.js';
import type {ProjectDefinitionProvider, ProjectDefinitionResult, ResolveForPackageOptions} from './project-definition-provider.js';

export class SfdxProjectDefinitionProvider implements ProjectDefinitionProvider {
  public readonly projectDir: string;

  constructor(private readonly sfProject: SfProject) {
    this.projectDir = sfProject.getPath();
  }

  resolve(): ProjectDefinitionResult {
    const definition = this.sfProject.getSfProjectJson().getContents() as unknown as ProjectDefinition;
    return {definition};
  }

  /**
   * Prune the full sfdx-project.json to a single-package definition.
   * Strips SFPM-specific properties and ensures the package is marked as default.
   */
  resolveForPackage(packageName: string, options?: ResolveForPackageOptions): ProjectDefinition {
    const {definition} = this.resolve();
    const pruned = structuredClone(definition) as ProjectDefinition;

    const filtered = pruned.packageDirectories.filter((pkg): pkg is PackageDefinition => 'package' in pkg && pkg.package === packageName);

    if (filtered.length === 0) {
      throw new Error(`Package "${packageName}" not found in sfdx-project.json`);
    }

    // Strip SFPM-specific properties that Salesforce CLI doesn't understand
    const {npmName: _npmName, packageOptions: _, type: _type, ...sfPkg} = filtered[0] as any;
    const standardPkgSchema = ProjectJsonSchema.shape.packageDirectories.element;
    const cleanPkg = standardPkgSchema.parse(sfPkg) as PackageDefinition;

    if (options?.isOrgDependent && cleanPkg.dependencies) {
      delete (cleanPkg as any).dependencies;
    }

    cleanPkg.default = true;
    pruned.packageDirectories = [cleanPkg];

    return pruned;
  }
}
