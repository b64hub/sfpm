import {
  ProjectJson, ProjectJsonSchema, SfProject, SfProjectJson,
} from '@salesforce/core';

import {
  Logger,
} from '../types/logger.js'
import {PackageType} from '../types/package.js';
import {
  ManagedPackageDefinition, PackageDefinition, ProjectDefinition, ProjectDefinitionSchema, SUBSCRIBER_PKG_VERSION_ID_PREFIX,
} from '../types/project.js';

/**
 * Dependency from sfdx-project.json packageDirectories[].dependencies
 */
type PackageDependency = {package: string; versionNumber?: string};

/**
 * Classified dependencies for a package as declared in sfdx-project.json.
 * - `versioned`: internal SFPM packages → semver range derived from versionNumber
 * - `managed`: pinned managed packages → subscriber packageVersionId (04t...)
 *
 * Keys are raw sfdx-project.json package names (no npm scope).
 */
export interface ClassifiedDependencies {
  managed: Record<string, string>;
  versioned: Record<string, string>;
}

/**
 * Configuration manager for sfdx-project.json
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

  /**
   * Classifies a package's dependencies into versioned (internal) and managed (pinned)
   * using raw sfdx-project.json names — no npm scope transformation.
   *
   * Versioned dependencies have a `versionNumber` and are mapped to a semver range.
   * Managed dependencies have no `versionNumber` — they reference aliases in
   * `packageAliases` that resolve to a subscriber packageVersionId (04t...).
   *
   * @example
   * ```typescript
   * const deps = projectConfig.classifyDependencies('my-package');
   * // deps.versioned  → { "core-lib": "^1.2.0" }
   * // deps.managed    → { "Nebula Logger@4.16.0": "04taA000005CtsHQAS" }
   * ```
   */
  public classifyDependencies(packageName: string): ClassifiedDependencies {
    const dependencies = this.getDependencies(packageName);
    const aliases = this.getProjectDefinition().packageAliases ?? {};

    const versioned: Record<string, string> = {};
    const managed: Record<string, string> = {};

    for (const dep of dependencies) {
      if (dep.versionNumber) {
        // Internal / versioned dependency → semver range from SF version number
        const parts = dep.versionNumber.split('.');
        const baseVersion = parts.length >= 3 ? parts.slice(0, 3).join('.') : dep.versionNumber;
        versioned[dep.package] = `^${baseVersion}`;
      } else {
        // Managed / pinned dependency → alias resolved to 04t via packageAliases
        const packageVersionId = aliases[dep.package];
        if (packageVersionId) {
          managed[dep.package] = packageVersionId;
        }
      }
    }

    return {managed, versioned};
  }

  /**
   * Returns all package directories from the project.
   * Uses raw project JSON to include all fields including 'package'.
   */
  public getAllPackageDirectories(): PackageDefinition[] {
    const projectDef = this.getProjectDefinition();
    return projectDef.packageDirectories as PackageDefinition[];
  }

  /**
   * Returns all unique package names from the 'package' field.
   * Filters out entries without a package name.
   */
  public getAllPackageNames(): string[] {
    const allDirs = this.getAllPackageDirectories();
    return allDirs
    .filter(dir => 'package' in dir && dir.package)
    .map(dir => dir.package as string);
  }

  /**
   * Returns the raw dependencies for a package from sfdx-project.json.
   */
  public getDependencies(packageName: string): PackageDependency[] {
    return this.getPackageDefinition(packageName).dependencies ?? [];
  }

  /**
   * Returns all managed (external) package dependencies found across the project.
   *
   * A managed dependency is one that:
   * - Appears in a package's `dependencies` array
   * - Has NO entry in `packageDirectories` (no local source)
   * - Resolves via `packageAliases` to a subscriber package version ID (04t prefix)
   *
   * @returns Array of ManagedPackageDefinition, deduplicated by package name
   */
  public getManagedPackages(): ManagedPackageDefinition[] {
    const projectDef = this.getProjectDefinition();
    const packageAliases: Record<string, string> = (projectDef.packageAliases as Record<string, string>) ?? {};
    const localPackageNames = new Set(this.getAllPackageNames());
    const managed = new Map<string, ManagedPackageDefinition>();

    for (const pkgDir of projectDef.packageDirectories) {
      const pkg = pkgDir as PackageDefinition;
      if (!pkg.dependencies) continue;

      for (const dep of pkg.dependencies) {
        if (localPackageNames.has(dep.package)) continue;
        if (managed.has(dep.package)) continue;

        const aliasValue = packageAliases[dep.package];
        if (aliasValue?.startsWith(SUBSCRIBER_PKG_VERSION_ID_PREFIX)) {
          managed.set(dep.package, {
            package: dep.package,
            packageVersionId: aliasValue,
          });
        }
      }
    }

    return [...managed.values()];
  }

  /**
   * Finds a package definition by name.
   * Searches through packageDirectories for a matching 'package' field.
   */
  public getPackageDefinition(packageName: string): PackageDefinition {
    // Get all package directories and search for matching package name
    const allPackages = this.getAllPackageDirectories();
    const pkg = allPackages.find(p => p.package === packageName);

    if (!pkg) {
      throw new Error(`Package ${packageName} not found in project definition`);
    }

    return pkg;
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
    const aliases = this.project.getSfProjectJson().getContents().packageAliases;
    return aliases?.[packageAlias];
  }

  /**
   * Helper to get package type
   */
  public getPackageType(packageName: string): PackageType {
    const pkg = this.getPackageDefinition(packageName);
    if (pkg.type) {
      return pkg.type as PackageType;
    }

    return PackageType.Unlocked;
  }

  // =========================================================================
  // Managed Packages
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
  // Dependency Resolution
  // =========================================================================

  /**
   * Returns a deep copy of the project definition, pruned to contain only the specified package
   * directory. This is useful for creating artifact-specific manifests (sfdx-project.json)
   * where only the metadata related to one package should be visible.
   *
   * @param packageName The name of the package to keep in the definition.
   * @returns A new ProjectDefinition containing only the requested package.
   * @throws Error if the package name is not found in the project.
   *
   * @example
   * ```typescript
   * const pruned = projectConfig.getPrunedDefinition('core-library');
   * console.log(pruned.packageDirectories.length); // 1
   * ```
   */
  // eslint-disable-next-line unicorn/no-object-as-default-parameter -- we want to allow callers to omit pruneOptions and get default pruning behavior
  public getPrunedDefinition(packageName: string, pruneOptions: {isOrgDependent: boolean; removeCustomProperties: boolean,} = {isOrgDependent: false, removeCustomProperties: true}): ProjectDefinition {
    const definition = this.getProjectDefinition();
    // eslint-disable-next-line n/no-unsupported-features/node-builtins -- structuredClone is available in Node 17+ and provides a convenient way to deep copy the project definition without mutating the original
    const pruned = structuredClone(definition) as ProjectDefinition;

    const filteredPackages = pruned.packageDirectories.filter((pkg): pkg is PackageDefinition => 'package' in pkg && pkg.package === packageName);

    if (filteredPackages.length === 0) {
      throw new Error(`Package ${packageName} not found in project definition`);
    }

    pruned.packageDirectories = pruneOptions.removeCustomProperties ? [this.pruneForSalesforce(filteredPackages[0], pruneOptions.isOrgDependent)] : filteredPackages;

    return pruned;
  }

  // =========================================================================
  // Project Definition Pruning
  // =========================================================================

  /**
   * Saves the project definition back to the file
   */
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

    // Reset validation flag since file has changed
    this.hasValidated = false;
  }

  /**
   * Prunes a package definition for Salesforce CLI compatibility
   */
  private pruneForSalesforce(pkg: PackageDefinition, isOrgDependent: boolean = false): PackageDefinition {
    const standardPkgSchema = ProjectJsonSchema.shape.packageDirectories.element;
    const cleanPkg = standardPkgSchema.parse(pkg) as any;

    if (isOrgDependent && cleanPkg.dependencies) {
      delete cleanPkg.dependencies;
    }

    return cleanPkg;
  }

  /**
   * Validates custom SFPM properties (runs once, logs warnings only).
   * This is called automatically by getProjectDefinition().
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
