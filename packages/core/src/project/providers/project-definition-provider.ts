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

import type {WorkspacePackageJson} from './types/workspace.js';

import {PackageType} from '../../types/package.js';
import {
  type PackageDefinition,
  type ProjectDefinition,
} from '../../types/project.js';

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
 * The interface covers two concerns:
 * 1. **Resolution** — `resolve()` and `resolveForPackage()` produce definitions.
 * 2. **Package queries** — `getPackageDefinition()`, `getAllPackageNames()`, `getDependencies()`, etc.
 */
export interface ProjectDefinitionProvider {
  /** All package definitions from the project definition. */
  getAllPackageDefinitions(): PackageDefinition[];

  /** All unique package names. */
  getAllPackageNames(): string[];

  /**
   * Resolved workspace dependencies for a package.
   *
   * Returns the PackageDefinition for each workspace dependency declared
   * in the package's `dependencies` record. Managed dependencies are NOT
   * included — access them directly via `getPackageDefinition().managedDependencies`.
   */
  getDependencies(packageName: string): PackageDefinition[];

  /** Lookup a package definition by name. Throws if not found. */
  getPackageDefinition(packageName: string): PackageDefinition;

  /** Lookup a package definition by its path. Throws if not found. */
  getPackageDefinitionByPath(packagePath: string): PackageDefinition;

  /** The resolved package type (defaults to Unlocked when unspecified). */
  getPackageType(packageName: string): PackageType;

  /** The full project definition. Convenience for `resolve().definition`. */
  getProjectDefinition(): ProjectDefinition;

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
   * The returned definition has exactly one package entry (with `packageOptions.default: true`),
   * and project-level settings.
   */
  resolveForPackage(packageName: string, options?: ResolveForPackageOptions): ProjectDefinition;

  /**
   * Update fields on a package's backing configuration.
   * WorkspaceProvider writes to package.json; SfdxProjectProvider writes to sfdx-project.json.
   */
  updatePackageConfig(packageName: string, updates: Partial<PackageDefinition>): Promise<void>;
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
  return definition.packages;
}

export function getAllPackageNames(definition: ProjectDefinition): string[] {
  return getAllPackageDefinitions(definition).map(pkg => pkg.name);
}

export function getPackageDefinition(definition: ProjectDefinition, packageName: string): PackageDefinition {
  const pkg = getAllPackageDefinitions(definition).find(p => p.name === packageName);
  if (!pkg) {
    throw new Error(`Package ${packageName} not found in project definition`);
  }

  return pkg;
}

export function getPackageType(definition: ProjectDefinition, packageName: string): PackageType {
  const pkg = getPackageDefinition(definition, packageName);
  return (pkg.type as PackageType) || PackageType.Unlocked;
}

export function getPackageDefinitionByPath(definition: ProjectDefinition, packagePath: string): PackageDefinition {
  const pkg = getAllPackageDefinitions(definition).find(p => p.path === packagePath);
  if (!pkg) {
    throw new Error(`No package found with path: ${packagePath}`);
  }

  return pkg;
}

// ---------------------------------------------------------------------------
// Dependency queries
// ---------------------------------------------------------------------------

/**
 * Resolve workspace dependencies for a package.
 *
 * Looks up the package's `dependencies` record and resolves each entry
 * to its PackageDefinition from the project's packages list.
 * Only returns dependencies that exist in the project — external/unresolvable
 * dependencies are silently skipped.
 */
export function getDependencies(definition: ProjectDefinition, packageName: string): PackageDefinition[] {
  const pkg = getPackageDefinition(definition, packageName);
  if (!pkg.dependencies) return [];

  const resolved: PackageDefinition[] = [];
  for (const depName of Object.keys(pkg.dependencies)) {
    const depPkg = definition.packages.find(p => p.name === depName);
    if (depPkg) {
      resolved.push(depPkg);
    }
  }

  return resolved;
}
