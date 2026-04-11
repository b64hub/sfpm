/**
 * Adapter for converting between workspace package.json files and Salesforce
 * PackageDefinition / ProjectDefinition structures.
 *
 * This module bridges the "package.json-first" workspace model with the
 * sfdx-project.json format that Salesforce CLI requires.
 *
 * Direction: WorkspacePackageJson → PackageDefinition (for sync)
 *
 * @example
 * ```typescript
 * const pkgJson = JSON.parse(fs.readFileSync('packages/core/package.json', 'utf8'));
 * const definition = toPackageDefinition(pkgJson, 'packages/core');
 * // → { package: 'core-package', path: 'packages/core/force-app', versionNumber: '1.0.0.NEXT', ... }
 * ```
 */

import path from 'node:path';

import type {PackageType} from '../types/package.js';
import type {ManagedPackageDefinition, PackageDefinition} from '../types/project.js';
import type {SfpmPackageConfig, WorkspacePackageJson} from '../types/workspace.js';

import {toSalesforceVersionWithToken} from '../utils/version-utils.js';

// ---------------------------------------------------------------------------
// WorkspacePackageJson → PackageDefinition
// ---------------------------------------------------------------------------

/**
 * Convert a workspace package.json into a Salesforce PackageDefinition
 * suitable for inclusion in sfdx-project.json's `packageDirectories`.
 *
 * @param pkgJson           - The workspace member's package.json
 * @param packageDir        - Relative path from project root to the package directory (e.g., "packages/core")
 * @param workspaceVersions - Map of workspace package names → versions (for resolving dep version numbers)
 * @returns A PackageDefinition for sfdx-project.json
 */
export function toPackageDefinition(
  pkgJson: WorkspacePackageJson,
  packageDir: string,
  workspaceVersions?: Map<string, string>,
): PackageDefinition {
  const {sfpm} = pkgJson;
  const packageName = stripScope(pkgJson.name);

  // Convert semver version to Salesforce format with appropriate build token
  const sfVersion = toSalesforceVersionWithToken(pkgJson.version, sfpm.packageType);
  // Build the path by combining the package directory with the SF source path
  const sourcePath = path.posix.join(packageDir, sfpm.path ?? '.');

  const definition: PackageDefinition = {
    package: packageName,
    path: sourcePath,
    versionNumber: sfVersion,
  };

  // Set explicit type if not the default
  if (sfpm.packageType) {
    definition.type = sfpm.packageType as PackageType;
  }

  // Copy optional SF-specific fields
  if (sfpm.versionDescription) {
    definition.versionDescription = sfpm.versionDescription;
  }

  // Unlocked package fields
  if (sfpm.ancestorId) {
    (definition as any).ancestorId = sfpm.ancestorId;
  }

  if (sfpm.ancestorVersion) {
    (definition as any).ancestorVersion = sfpm.ancestorVersion;
  }

  if (sfpm.definitionFile) {
    (definition as any).definitionFile = sfpm.definitionFile;
  }

  if (sfpm.isOrgDependent) {
    (definition as any).orgDependent = sfpm.isOrgDependent;
  }

  // Resolve path-based fields relative to the package directory
  if (sfpm.seedMetadata) {
    (definition as any).seedMetadata = {
      path: path.posix.join(packageDir, sfpm.seedMetadata),
    };
  }

  if (sfpm.unpackagedMetadata) {
    (definition as any).unpackagedMetadata = {
      path: path.posix.join(packageDir, sfpm.unpackagedMetadata),
    };
  }

  // Note: packageOptions is NOT synced to sfdx-project.json.
  // It lives exclusively in the workspace package.json and is read directly
  // by PackageFactory during build/install.

  // Build dependencies array from workspace dependencies
  const dependencies = buildDependenciesArray(pkgJson, sfpm, workspaceVersions);
  if (dependencies.length > 0) {
    (definition as any).dependencies = dependencies;
  }

  return definition;
}

// ---------------------------------------------------------------------------
// Dependencies
// ---------------------------------------------------------------------------

/**
 * Build the `dependencies` array for sfdx-project.json from workspace deps
 * and managed deps declared in the sfpm config.
 *
 * Workspace deps (workspace:^x.y.z) become versioned SF dependencies using
 * the depended-on package's actual version from the workspace.
 * Managed deps (from sfpm.managedDependencies) become unversioned references
 * resolved via packageAliases.
 */
function buildDependenciesArray(
  pkgJson: WorkspacePackageJson,
  sfpm: SfpmPackageConfig,
  workspaceVersions?: Map<string, string>,
): Array<{package: string; versionNumber?: string}> {
  const deps: Array<{package: string; versionNumber?: string}> = [];

  // Workspace dependencies → SF versioned dependencies
  if (pkgJson.dependencies) {
    for (const [depName, version] of Object.entries(pkgJson.dependencies)) {
      // Only include workspace: dependencies (local SF packages)
      if (typeof version === 'string' && version.startsWith('workspace:')) {
        const sfDepName = stripScope(depName);
        // Look up the depended-on package's version to emit versionNumber
        const depVersion = workspaceVersions?.get(depName);
        if (depVersion) {
          // Convert semver to SF dependency format: major.minor.patch.LATEST
          // Strip any prerelease segment (e.g., "1.2.0-3" → "1.2.0") then append LATEST
          const base = depVersion.split('-')[0];
          deps.push({package: sfDepName, versionNumber: `${base}.LATEST`});
        } else {
          deps.push({package: sfDepName});
        }
      }
    }
  }

  // Managed dependencies → SF unversioned references (resolved via packageAliases)
  if (sfpm.managedDependencies) {
    for (const alias of Object.keys(sfpm.managedDependencies)) {
      deps.push({package: alias});
    }
  }

  return deps;
}

// ---------------------------------------------------------------------------
// Managed dependencies aggregation
// ---------------------------------------------------------------------------

/**
 * Collect all managed dependencies across workspace packages into a single
 * `packageAliases` map for sfdx-project.json.
 *
 * @param packages - Array of workspace package.json contents
 * @returns Combined packageAliases map (alias → 04t subscriber version ID)
 */
export function collectPackageAliases(packages: WorkspacePackageJson[]): Record<string, string> {
  const aliases: Record<string, string> = {};

  for (const pkgJson of packages) {
    const managed = pkgJson.sfpm?.managedDependencies;
    if (!managed) continue;

    for (const [alias, versionId] of Object.entries(managed)) {
      if (aliases[alias] && aliases[alias] !== versionId) {
        throw new Error(`Conflicting managed dependency: "${alias}" resolves to `
          + `"${aliases[alias]}" in one package but "${versionId}" in another. `
          + 'All packages must agree on managed dependency versions.');
      }

      aliases[alias] = versionId;
    }
  }

  return aliases;
}

/**
 * Extract managed package definitions from collected aliases.
 */
export function toManagedPackageDefinitions(aliases: Record<string, string>): ManagedPackageDefinition[] {
  return Object.entries(aliases).map(([alias, versionId]) => ({
    package: alias,
    packageVersionId: versionId,
  }));
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

/**
 * Strip the npm scope from a package name.
 * "@myorg/core-package" → "core-package"
 * "core-package" → "core-package"
 */
export function stripScope(name: string): string {
  const match = name.match(/^@[^/]+\/(.+)$/);
  return match ? match[1] : name;
}
