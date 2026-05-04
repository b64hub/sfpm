import {
  ProjectJsonSchema, SfProject,
} from '@salesforce/core';

import type {ClassifiedDependencies, PackageDependency} from './providers/project-definition-provider.js';

import {
  Logger,
} from '../types/logger.js'
import {PackageType} from '../types/package.js';
import {
  ManagedPackageDefinition, PackageDefinition, ProjectDefinition, ProjectDefinitionSchema,
} from '../types/project.js';
import {
  classifyDependencies,
  getAllPackageDefinitions,
  getAllPackageNames,
  getDependencies,
  getManagedPackages,
  getPackageDefinition,
  getPackageId,
  getPackageType,
} from './providers/project-definition-provider.js';

/**
 * @deprecated Import `ClassifiedDependencies` from `project-definition-provider.js` instead.
 */
export type {ClassifiedDependencies} from './providers/project-definition-provider.js';

/**
 * Configuration manager for sfdx-project.json.
 *
 * Query methods now delegate to shared utility functions in `project-definition-provider.ts`
 * which are the same functions used by both providers. For new code, prefer
 * accessing queries via `ProjectService` (which delegates to the provider).
 *
 * Unique responsibilities that remain here:
 * - `save()` — writes back to sfdx-project.json via `@salesforce/core`
 * - `getPackageDefinitionByPath()` — uses `SfProject.getPackage()`
 * - `getProjectDefinition()` — Zod validation on first access
 */
export default class ProjectConfig {
  public logger?: Logger;
  private hasValidated = false;
  private project: SfProject;

  constructor(project: SfProject) {
    this.project = project;
  }

  /**
   * Returns the project directory (root path)
   */
  public get projectDirectory(): string {
    return this.project.getPath();
  }

  /**
   * Returns the source API version of the project
   */
  public get sourceApiVersion(): string | undefined {
    return this.getProjectDefinition().sourceApiVersion;
  }

  public classifyDependencies(packageName: string): ClassifiedDependencies {
    return classifyDependencies(this.getProjectDefinition(), packageName);
  }

  /**
   * Returns all package directories from the project.
   */
  public getAllPackageDirectories(): PackageDefinition[] {
    return getAllPackageDefinitions(this.getProjectDefinition());
  }

  /**
   * Returns all unique package names from the 'package' field.
   */
  public getAllPackageNames(): string[] {
    return getAllPackageNames(this.getProjectDefinition());
  }

  /**
   * Returns the raw dependencies for a package.
   */
  public getDependencies(packageName: string): PackageDependency[] {
    return getDependencies(this.getProjectDefinition(), packageName);
  }

  public getManagedPackages(): ManagedPackageDefinition[] {
    return getManagedPackages(this.getProjectDefinition());
  }

  public getPackageDefinition(packageName: string): PackageDefinition {
    return getPackageDefinition(this.getProjectDefinition(), packageName);
  }

  /**
   * Finds a package definition by its path.
   * Uses SfProject's native getPackage() method for efficient lookup.
   */
  public getPackageDefinitionByPath(packagePath: string): PackageDefinition {
    const pkg = this.project.getPackage(packagePath) as PackageDefinition;

    if (!pkg || !pkg.package) {
      throw new Error(`No package found with path: ${packagePath}`);
    }

    return pkg;
  }

  public getPackageId(packageAlias: string): string | undefined {
    return getPackageId(this.getProjectDefinition(), packageAlias);
  }

  public getPackageType(packageName: string): PackageType {
    return getPackageType(this.getProjectDefinition(), packageName);
  }

  // =========================================================================
  // Project definition
  // =========================================================================

  /**
   * Returns the project definition with custom SFPM properties.
   * Always gets fresh data from SfProject and validates on first access.
   */
  public getProjectDefinition(): ProjectDefinition {
    this.validateCustomProperties();
    return this.project.getSfProjectJson().getContents() as ProjectDefinition;
  }

  // =========================================================================
  // Deprecated
  // =========================================================================

  /**
   * @deprecated Use `ProjectService.resolveForPackage()` instead.
   */
  // eslint-disable-next-line unicorn/no-object-as-default-parameter
  public getPrunedDefinition(packageName: string, pruneOptions: {isOrgDependent: boolean; removeCustomProperties: boolean,} = {isOrgDependent: false, removeCustomProperties: true}): ProjectDefinition {
    const definition = this.getProjectDefinition();

    const pruned = structuredClone(definition) as ProjectDefinition;

    const filteredPackages = pruned.packageDirectories.filter((pkg): pkg is PackageDefinition => 'package' in pkg && pkg.package === packageName);

    if (filteredPackages.length === 0) {
      throw new Error(`Package ${packageName} not found in project definition`);
    }

    const prunedPkg = pruneOptions.removeCustomProperties ? this.pruneForSalesforce(filteredPackages[0], pruneOptions.isOrgDependent) : filteredPackages[0];

    // Ensure the sole remaining package is marked as the default — Salesforce CLI
    // requires exactly one default directory when only one entry exists.
    prunedPkg.default = true;
    pruned.packageDirectories = [prunedPkg];

    return pruned;
  }

  // =========================================================================
  // Write operations (SfProject-specific)
  // =========================================================================

  /**
   * Saves the project definition back to the file.
   * Note: After saving, validation state is reset since the file has changed.
   */
  public async save(updatedDefinition?: ProjectDefinition): Promise<void> {
    const projectJson = this.project.getSfProjectJson();
    const dataToSave = updatedDefinition || projectJson.getContents();

    // Use individual set calls to avoid protected setContents
    projectJson.set('packageDirectories', dataToSave.packageDirectories);
    if (dataToSave.packageAliases) {
      projectJson.set('packageAliases', dataToSave.packageAliases);
    }

    if (dataToSave.sourceApiVersion) {
      projectJson.set('sourceApiVersion', dataToSave.sourceApiVersion);
    }

    await projectJson.write();
    this.hasValidated = false;
  }

  // =========================================================================
  // Private
  // =========================================================================

  /**
   * Prunes a package definition for Salesforce CLI compatibility
   */
  private pruneForSalesforce(pkg: PackageDefinition, isOrgDependent: boolean = false): PackageDefinition {
    // Strip SFPM-specific properties before parsing against the standard Salesforce schema,
    // which does not recognize custom fields like packageOptions or type.
    const {packageOptions: _, type: _type, ...sfPkg} = pkg as any;
    const standardPkgSchema = ProjectJsonSchema.shape.packageDirectories.element;
    const cleanPkg = standardPkgSchema.parse(sfPkg) as any;

    if (isOrgDependent && cleanPkg.dependencies) {
      delete cleanPkg.dependencies;
    }

    return cleanPkg;
  }

  /**
   * Validates custom SFPM properties (runs once, logs warnings only).
   */
  private validateCustomProperties(): void {
    if (this.hasValidated) return;

    const rawContents = this.project.getSfProjectJson().getContents();
    const result = ProjectDefinitionSchema.safeParse(rawContents);

    if (!result.success) {
      this.logger?.warn('SFPM custom properties validation failed:');
      const zodError = result.error;
      if (zodError && 'errors' in zodError && Array.isArray(zodError.errors)) {
        for (const err of zodError.errors) {
          const path = err.path?.join('.') || 'unknown';
          this.logger?.warn(`  - ${path}: ${err.message}`);
        }
      }

      this.logger?.warn('Continuing with potentially invalid custom properties...');
    }

    this.hasValidated = true;
  }
}
