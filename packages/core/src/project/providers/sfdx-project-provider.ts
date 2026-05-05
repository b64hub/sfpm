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

import {type ProjectJson, SfProject} from '@salesforce/core';
import fs from 'node:fs';
import path from 'node:path';

import type {PackageType} from '../../types/package.js';
import type {PackageDefinition, type ProjectDefinition, ProjectDefinitionSchema} from '../../types/project.js';
import type {
  ProjectDefinitionProvider,
  ProjectDefinitionResult,
  ResolveForPackageOptions,
} from './project-definition-provider.js';

import {stripScope} from '../../utils/scope-utils.js';
import {
  getAllPackageDefinitions,
  getAllPackageNames,
  getDependencies,
  getPackageDefinition,
  getPackageDefinitionByPath,
  getPackageType,
} from './project-definition-provider.js';
import {fromSalesforceProjectJson, toSalesforceProjectJson} from './sfdx-project-adapter.js';

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

  getAllPackageDefinitions(): PackageDefinition[] {
    return getAllPackageDefinitions(this.resolve().definition);
  }

  // -- Package queries ------------------------------------------------------

  getAllPackageNames(): string[] {
    return getAllPackageNames(this.resolve().definition);
  }

  getDependencies(packageName: string): PackageDefinition[] {
    return getDependencies(this.resolve().definition, packageName);
  }

  getPackageDefinition(packageName: string): PackageDefinition {
    return getPackageDefinition(this.resolve().definition, packageName);
  }

  getPackageDefinitionByPath(packagePath: string): PackageDefinition {
    return getPackageDefinitionByPath(this.resolve().definition, packagePath);
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
    const validated = this.validate(definition);
    return {definition: validated};
  }

  /**
   * Resolve a single-package definition for staging and building.
   *
   * Prunes the full project to just the target package and marks it as default.
   */
  resolveForPackage(packageName: string, options?: ResolveForPackageOptions): ProjectDefinition {
    const {definition} = this.resolve();
    const pruned = structuredClone(definition);

    const filtered = pruned.packages.filter(pkg => pkg.name === packageName);

    if (filtered.length === 0) {
      throw new Error(`Package "${packageName}" not found in sfdx-project.json`);
    }

    const pkg = filtered[0];

    if (options?.isOrgDependent && pkg.dependencies) {
      delete pkg.dependencies;
    }

    pkg.default = true;
    pruned.packages = [pkg];

    return pruned;
  }

  // -- Write operations -----------------------------------------------------

  /**
   * Update fields on a package's entry in sfdx-project.json.
   * Deep-merges onto existing content to preserve user-added fields.
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
      raw.packageAliases = raw.packageAliases ?? {};
      raw.packageAliases[packageName] = updates.packageId;
    }

    if (updates.name !== undefined) pkgDir.package = stripScope(updates.name);
    if (updates.version !== undefined) pkgDir.versionNumber = updates.version;
    if (updates.description !== undefined) pkgDir.versionDescription = updates.description;

    // Update dependency versions in the SF dependencies array
    if (updates.dependencies !== undefined && Array.isArray(pkgDir.dependencies)) {
      for (const [depName, depVersion] of Object.entries(updates.dependencies)) {
        const sfDep = pkgDir.dependencies.find((d: Record<string, unknown>) => d.package === depName);
        if (sfDep) {
          sfDep.versionNumber = `${depVersion}.LATEST`;
        }
      }
    }

    fs.writeFileSync(sfdxPath, JSON.stringify(raw, null, 2) + '\n', 'utf8');
  }

  /**
   * Validate a ProjectDefinition against the Zod schema.
   * Wraps ZodError into a user-friendly message.
   */
  private validate(definition: ProjectDefinition): ProjectDefinition {
    const result = ProjectDefinitionSchema.safeParse(definition);
    if (!result.success) {
      const issues = result.error.issues
      .map(i => `  - ${i.path.join('.')}: ${i.message}`)
      .join('\n');
      throw new Error(`Invalid project definition in sfdx-project.json:\n${issues}`);
    }

    return result.data as ProjectDefinition;
  }
}
