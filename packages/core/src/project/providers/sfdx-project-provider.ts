/**
 * Legacy sfdx-project.json–based ProjectDefinitionProvider.
 *
 * Reads the project definition directly from sfdx-project.json via
 * @salesforce/core's SfProject, then converts to SFPM's canonical
 * ProjectDefinition using the adapter functions.
 *
 * This is the traditional approach used when no workspace configuration
 * is detected.
 */

import fs from 'node:fs';
import path from 'node:path';

import {SfProject, type ProjectJson} from '@salesforce/core';

import type {PackageType} from '../../types/package.js';
import type {ManagedPackageDefinition, PackageDefinition, ProjectDefinition} from '../../types/project.js';
import type {
  ClassifiedDependencies,
  PackageDependency,
  ProjectDefinitionProvider,
  ProjectDefinitionResult,
  ResolveForPackageOptions,
} from './project-definition-provider.js';

import {fromSalesforceProjectJson, toSalesforceProjectJson} from '../package-json-adapter.js';
import {
  classifyDependencies,
  getAllPackageDefinitions,
  getAllPackageNames,
  getDependencies,
  getManagedPackages,
  getPackageDefinition,
  getPackageDefinitionByPath,
  getPackageId,
  getPackageType,
} from './project-definition-provider.js';

/**
 * Extension of the standard Salesforce Package Directory (packageDirectories entry).
 * Kept for external consumers that need SF interop.
 */
export type PackageDir = ProjectJson['packageDirectories'][number];

export class SfdxProjectProvider implements ProjectDefinitionProvider {
  public readonly projectDir: string;

  constructor(private readonly sfProject: SfProject) {
    this.projectDir = sfProject.getPath();
  }

  // -- Resolution -----------------------------------------------------------

  classifyDependencies(packageName: string): ClassifiedDependencies {
    return classifyDependencies(this.resolve().definition, packageName);
  }

  getAllPackageDefinitions(): PackageDefinition[] {
    return getAllPackageDefinitions(this.resolve().definition);
  }

  // -- Package queries ------------------------------------------------------

  getAllPackageNames(): string[] {
    return getAllPackageNames(this.resolve().definition);
  }

  getDependencies(packageName: string): PackageDependency[] {
    return getDependencies(this.resolve().definition, packageName);
  }

  getManagedPackages(): ManagedPackageDefinition[] {
    return getManagedPackages(this.resolve().definition);
  }

  getPackageDefinition(packageName: string): PackageDefinition {
    return getPackageDefinition(this.resolve().definition, packageName);
  }

  getPackageDefinitionByPath(packagePath: string): PackageDefinition {
    return getPackageDefinitionByPath(this.resolve().definition, packagePath);
  }

  getPackageId(packageAlias: string): string | undefined {
    return getPackageId(this.resolve().definition, packageAlias);
  }

  getPackageType(packageName: string): PackageType {
    return getPackageType(this.resolve().definition, packageName);
  }

  // -- Dependency queries ---------------------------------------------------

  getProjectDefinition(): ProjectDefinition {
    return this.resolve().definition;
  }

  /**
   * Resolve by reading sfdx-project.json via SfProject and converting
   * to SFPM's canonical ProjectDefinition using the adapter.
   */
  resolve(): ProjectDefinitionResult {
    const raw = this.sfProject.getSfProjectJson().getContents() as unknown as Record<string, unknown>;
    const definition = fromSalesforceProjectJson(raw);
    return {definition};
  }

  /**
   * Resolve a single-package definition for staging and building.
   *
   * Prunes the full project to just the target package, strips SFPM-only
   * fields, and marks it as default.
   */
  resolveForPackage(packageName: string, options?: ResolveForPackageOptions): ProjectDefinition {
    const {definition} = this.resolve();
    const pruned = structuredClone(definition);

    const filtered = pruned.packageDirectories.filter(pkg => pkg.package === packageName);

    if (filtered.length === 0) {
      throw new Error(`Package "${packageName}" not found in sfdx-project.json`);
    }

    const pkg = filtered[0];

    // Strip SFPM-specific properties for SF CLI
    delete pkg.npmName;
    delete pkg.packageOptions;
    delete pkg.type;
    delete pkg.packageId;

    if (options?.isOrgDependent && pkg.dependencies) {
      delete pkg.dependencies;
    }

    pkg.default = true;
    pruned.packageDirectories = [pkg];

    return pruned;
  }

  // -- Write operations -----------------------------------------------------

  /**
   * Update fields on a package's entry in sfdx-project.json.
   */
  async updatePackageConfig(packageName: string, updates: Partial<PackageDefinition>): Promise<void> {
    const sfdxPath = path.join(this.projectDir, 'sfdx-project.json');
    const raw = JSON.parse(fs.readFileSync(sfdxPath, 'utf8'));

    if (!Array.isArray(raw.packageDirectories)) return;

    const pkgDir = raw.packageDirectories.find((d: Record<string, unknown>) => d.package === packageName);
    if (!pkgDir) {
      throw new Error(`Package "${packageName}" not found in sfdx-project.json`);
    }

    // Apply updates — convert SFPM field names to SF field names where needed
    if (updates.packageId !== undefined) {
      // Also store in packageAliases
      raw.packageAliases = raw.packageAliases ?? {};
      raw.packageAliases[packageName] = updates.packageId;
    }

    if (updates.versionNumber !== undefined) pkgDir.versionNumber = updates.versionNumber;
    if (updates.ancestorId !== undefined) pkgDir.ancestorId = updates.ancestorId;
    if (updates.ancestorVersion !== undefined) pkgDir.ancestorVersion = updates.ancestorVersion;
    if (updates.definitionFile !== undefined) pkgDir.definitionFile = updates.definitionFile;
    if (updates.versionDescription !== undefined) pkgDir.versionDescription = updates.versionDescription;
    if (updates.isOrgDependent !== undefined) pkgDir.orgDependent = updates.isOrgDependent;

    fs.writeFileSync(sfdxPath, JSON.stringify(raw, null, 2) + '\n', 'utf8');
  }

  /**
   * Merge aliases into sfdx-project.json's packageAliases.
   */
  async updatePackageAliases(aliases: Record<string, string>): Promise<void> {
    const sfdxPath = path.join(this.projectDir, 'sfdx-project.json');
    const raw = JSON.parse(fs.readFileSync(sfdxPath, 'utf8'));

    raw.packageAliases = {...(raw.packageAliases ?? {}), ...aliases};

    fs.writeFileSync(sfdxPath, JSON.stringify(raw, null, 2) + '\n', 'utf8');
  }
}
