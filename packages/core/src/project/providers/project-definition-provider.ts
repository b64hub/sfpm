/**
 * Strategy interface for resolving and querying a ProjectDefinition.
 *
 * Implementations:
 * - `WorkspaceProvider`: reads workspace package.json files (package.json-first)
 * - `SfdxProjectProvider`: reads sfdx-project.json (legacy)
 *
 * Used by ProjectService as the single abstraction for all project/workspace
 * operations — the single abstraction for all project/workspace queries.
 */

import type {WorkspacePackageJson} from '../../types/workspace.js';

import {PackageType} from '../../types/package.js';
import {
  type ManagedPackageDefinition,
  type PackageDefinition,
  type ProjectDefinition,
  SUBSCRIBER_PKG_VERSION_ID_PREFIX,
} from '../../types/project.js';

// ---------------------------------------------------------------------------
// Dependency classification
// ---------------------------------------------------------------------------

/** Dependency from sfdx-project.json packageDirectories[].dependencies */
export type PackageDependency = {package: string; versionNumber?: string};

/**
 * Classified dependencies for a package as declared in the project definition.
 * - `versioned`: internal SFPM packages → semver range derived from versionNumber
 * - `managed`: pinned managed packages → subscriber packageVersionId (04t…)
 *
 * Keys are raw package names (no npm scope).
 */
export interface ClassifiedDependencies {
  managed: Record<string, string>;
  versioned: Record<string, string>;
}

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface ResolveForPackageOptions {
  /** Strip dependencies from the package definition (for org-dependent unlocked packages) */
  isOrgDependent?: boolean;
}

// ---------------------------------------------------------------------------
// Result
// ---------------------------------------------------------------------------

export interface ProjectDefinitionResult {
  /** The assembled project definition */
  definition: ProjectDefinition;
  /** Workspace package.json data, if resolved from a workspace */
  packages?: Array<{packageDir: string; pkgJson: WorkspacePackageJson}>;
  /** Warnings encountered during resolution */
  warnings?: string[];
}

// ---------------------------------------------------------------------------
// Provider interface
// ---------------------------------------------------------------------------

/**
 * Provides and queries a ProjectDefinition from some backing source.
 *
 * The interface covers three concerns:
 * 1. **Resolution** — `resolve()` and `resolveForPackage()` produce definitions.
 * 2. **Package queries** — `getPackageDefinition()`, `getAllPackageNames()`, etc.
 * 3. **Dependency queries** — `getDependencies()`, `classifyDependencies()`, `getManagedPackages()`.
 */
export interface ProjectDefinitionProvider {
  /**
   * Classify a package's dependencies into versioned (internal) and managed (pinned).
   *
   * Versioned: have a `versionNumber` → mapped to semver range.
   * Managed: no `versionNumber` → resolved via packageAliases to 04t IDs.
   */
  classifyDependencies(packageName: string): ClassifiedDependencies;

  // -- Resolution -----------------------------------------------------------

  /** All package directory entries from the project definition. */
  getAllPackageDefinitions(): PackageDefinition[];

  /** All unique package names (entries with a `package` field). */
  getAllPackageNames(): string[];

  // -- Package queries ------------------------------------------------------

  /** Raw dependencies array for a package. */
  getDependencies(packageName: string): PackageDependency[];

  /**
   * All external managed package dependencies across the project.
   *
   * A managed dependency is one that:
   * - Appears in a package's `dependencies` array
   * - Has NO entry in `packageDirectories` (no local source)
   * - Resolves via `packageAliases` to a subscriber package version ID (04t…)
   */
  getManagedPackages(): ManagedPackageDefinition[];

  /** Lookup a package definition by name. Throws if not found. */
  getPackageDefinition(packageName: string): PackageDefinition;

  /** Lookup a package definition by its path. Throws if not found. */
  getPackageDefinitionByPath(packagePath: string): PackageDefinition;

  /** Lookup the packageAliases value (0Ho / 04t) for a given alias. */
  getPackageId(packageAlias: string): string | undefined;

  /** The resolved package type (defaults to Unlocked when unspecified). */
  getPackageType(packageName: string): PackageType;

  /** The full project definition. Convenience for `resolve().definition`. */
  getProjectDefinition(): ProjectDefinition;

  // -- Dependency queries ---------------------------------------------------

  /** Absolute path to the project root */
  readonly projectDir: string;

  /**
   * Resolve the full project definition from the backing source.
   */
  resolve(): ProjectDefinitionResult;

  /**
   * Resolve a single-package ProjectDefinition suitable for staging and building.
   *
   * In workspace mode this builds from the package's own package.json.
   * In legacy mode this prunes the full sfdx-project.json to the target package.
   *
   * The returned definition has exactly one packageDirectory entry (marked `default: true`),
   * the relevant packageAliases, and project-level settings.
   */
  resolveForPackage(packageName: string, options?: ResolveForPackageOptions): ProjectDefinition;
}

/**
 * Pure utility functions that derive package/dependency information from a
 * ProjectDefinition. Used by both WorkspaceProvider and
 * SfdxProjectProvider to implement the query portion of
 * ProjectDefinitionProvider without duplication.
 */

// ---------------------------------------------------------------------------
// Package queries
// ---------------------------------------------------------------------------

export function getAllPackageDefinitions(definition: ProjectDefinition): PackageDefinition[] {
  return definition.packageDirectories as PackageDefinition[];
}

export function getAllPackageNames(definition: ProjectDefinition): string[] {
  return getAllPackageDefinitions(definition)
  .filter(dir => 'package' in dir && dir.package)
  .map(dir => dir.package as string);
}

export function getPackageDefinition(definition: ProjectDefinition, packageName: string): PackageDefinition {
  const pkg = getAllPackageDefinitions(definition).find(p => p.package === packageName);
  if (!pkg) {
    throw new Error(`Package ${packageName} not found in project definition`);
  }

  return pkg;
}

export function getPackageType(definition: ProjectDefinition, packageName: string): PackageType {
  const pkg = getPackageDefinition(definition, packageName);
  return (pkg.type as PackageType) || PackageType.Unlocked;
}

export function getPackageId(definition: ProjectDefinition, packageAlias: string): string | undefined {
  return (definition.packageAliases as Record<string, string> | undefined)?.[packageAlias];
}

export function getPackageDefinitionByPath(definition: ProjectDefinition, packagePath: string): PackageDefinition {
  const pkg = getAllPackageDefinitions(definition).find(p => p.path === packagePath);
  if (!pkg || !pkg.package) {
    throw new Error(`No package found with path: ${packagePath}`);
  }

  return pkg;
}

// ---------------------------------------------------------------------------
// Dependency queries
// ---------------------------------------------------------------------------

export function getDependencies(definition: ProjectDefinition, packageName: string): PackageDependency[] {
  return getPackageDefinition(definition, packageName).dependencies ?? [];
}

export function classifyDependencies(definition: ProjectDefinition, packageName: string): ClassifiedDependencies {
  const dependencies = getDependencies(definition, packageName);
  const aliases = (definition.packageAliases ?? {}) as Record<string, string>;

  const versioned: Record<string, string> = {};
  const managed: Record<string, string> = {};

  for (const dep of dependencies) {
    if (dep.versionNumber) {
      const parts = dep.versionNumber.split('.');
      const baseVersion = parts.length >= 3 ? parts.slice(0, 3).join('.') : dep.versionNumber;
      versioned[dep.package] = `^${baseVersion}`;
    } else {
      const packageVersionId = aliases[dep.package];
      if (packageVersionId) {
        managed[dep.package] = packageVersionId;
      }
    }
  }

  return {managed, versioned};
}

export function getManagedPackages(definition: ProjectDefinition): ManagedPackageDefinition[] {
  const packageAliases = (definition.packageAliases as Record<string, string>) ?? {};
  const localPackageNames = new Set(getAllPackageNames(definition));
  const managed = new Map<string, ManagedPackageDefinition>();

  for (const pkgDir of definition.packageDirectories) {
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
