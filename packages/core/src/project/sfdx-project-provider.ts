/**
 * Legacy sfdx-project.json–based ProjectDefinitionProvider.
 *
 * Reads the project definition directly from sfdx-project.json via
 * @salesforce/core's SfProject. This is the traditional approach used
 * when no workspace configuration is detected.
 */

import {ProjectJsonSchema, SfProject} from '@salesforce/core';

import type {PackageType} from '../types/package.js';
import type {ManagedPackageDefinition, PackageDefinition, ProjectDefinition} from '../types/project.js';
import type {
  ClassifiedDependencies,
  PackageDependency,
  ProjectDefinitionProvider,
  ProjectDefinitionResult,
  ResolveForPackageOptions,
} from './project-definition-provider.js';

import * as Q from './definition-queries.js';

export class SfdxProjectProvider implements ProjectDefinitionProvider {
  public readonly projectDir: string;

  constructor(private readonly sfProject: SfProject) {
    this.projectDir = sfProject.getPath();
  }

  // -- Resolution -----------------------------------------------------------

  classifyDependencies(packageName: string): ClassifiedDependencies {
    return Q.classifyDependencies(this.resolve().definition, packageName);
  }

  getAllPackageDefinitions(): PackageDefinition[] {
    return Q.getAllPackageDefinitions(this.resolve().definition);
  }

  // -- Package queries ------------------------------------------------------

  getAllPackageNames(): string[] {
    return Q.getAllPackageNames(this.resolve().definition);
  }

  getDependencies(packageName: string): PackageDependency[] {
    return Q.getDependencies(this.resolve().definition, packageName);
  }

  getManagedPackages(): ManagedPackageDefinition[] {
    return Q.getManagedPackages(this.resolve().definition);
  }

  getPackageDefinition(packageName: string): PackageDefinition {
    return Q.getPackageDefinition(this.resolve().definition, packageName);
  }

  getPackageDefinitionByPath(packagePath: string): PackageDefinition {
    return Q.getPackageDefinitionByPath(this.resolve().definition, packagePath);
  }

  getPackageId(packageAlias: string): string | undefined {
    return Q.getPackageId(this.resolve().definition, packageAlias);
  }

  getPackageType(packageName: string): PackageType {
    return Q.getPackageType(this.resolve().definition, packageName);
  }

  // -- Dependency queries ---------------------------------------------------

  getProjectDefinition(): ProjectDefinition {
    return this.resolve().definition;
  }

  resolve(): ProjectDefinitionResult {
    const definition = this.sfProject.getSfProjectJson().getContents() as unknown as ProjectDefinition;
    return {definition};
  }

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
