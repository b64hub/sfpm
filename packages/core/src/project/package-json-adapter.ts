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
import type {ManagedPackageDefinition, PackageDefinition, PackageDependency, ProjectDefinition} from '../types/project.js';
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
    npmName: pkgJson.name,
    package: packageName,
    path: sourcePath,
    versionNumber: sfVersion,
  };

  // Set explicit type if not the default
  if (sfpm.packageType) {
    definition.type = sfpm.packageType as PackageType;
  }

  // Copy optional SF-specific fields
  // versionDescription: prefer sfpm.versionDescription, fall back to top-level description
  const versionDescription = sfpm.versionDescription ?? (pkgJson.description as string | undefined);
  if (versionDescription) {
    definition.versionDescription = versionDescription;
  }

  // Unlocked package fields
  if (sfpm.ancestorId) {
    definition.ancestorId = sfpm.ancestorId;
  }

  if (sfpm.ancestorVersion) {
    definition.ancestorVersion = sfpm.ancestorVersion;
  }

  if (sfpm.definitionFile) {
    definition.definitionFile = sfpm.definitionFile;
  }

  if (sfpm.isOrgDependent) {
    definition.isOrgDependent = sfpm.isOrgDependent;
  }

  // Resolve path-based fields relative to the package directory
  if (sfpm.seedMetadata) {
    definition.seedMetadata = path.posix.join(packageDir, sfpm.seedMetadata);
  }

  if (sfpm.unpackagedMetadata) {
    definition.unpackagedMetadata = path.posix.join(packageDir, sfpm.unpackagedMetadata);
  }

  // packageOptions lives exclusively in workspace package.json and is read
  // directly by PackageFactory during build/install.
  if (sfpm.packageOptions) {
    definition.packageOptions = sfpm.packageOptions;
  }

  // packageId from workspace config
  if (sfpm.packageId) {
    definition.packageId = sfpm.packageId;
  }

  // Build dependencies array from workspace dependencies
  const dependencies = buildDependenciesArray(pkgJson, sfpm, workspaceVersions);
  if (dependencies.length > 0) {
    definition.dependencies = dependencies;
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
 * Managed deps (from managedDependencies) become unversioned references
 * resolved via packageAliases.
 */
function buildDependenciesArray(
  pkgJson: WorkspacePackageJson,
  sfpm: SfpmPackageConfig,
  workspaceVersions?: Map<string, string>,
): PackageDependency[] {
  const deps: PackageDependency[] = [];

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
  if (pkgJson.managedDependencies) {
    for (const alias of Object.keys(pkgJson.managedDependencies)) {
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
    const managed = pkgJson.managedDependencies;
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

/**
 * Extract the npm scope from a scoped package name.
 * "@myorg/core-package" → "@myorg"
 * "core-package" → undefined
 */
export function extractScope(name: string): string | undefined {
  const match = name.match(/^(@[^/]+)\//);
  return match ? match[1] : undefined;
}

// ---------------------------------------------------------------------------
// Salesforce project adapter
// ---------------------------------------------------------------------------

/**
 * Convert a ProjectDefinition into sfdx-project.json format.
 *
 * Strips SFPM-specific fields that Salesforce CLI doesn't understand
 * and converts flat field formats to the nested SF representations
 * (e.g., `seedMetadata: "path"` → `seedMetadata: {path: "path"}`).
 *
 * Replaces `WorkspaceProvider.cleanForSalesforce()`.
 */
export function toSalesforceProjectJson(definition: ProjectDefinition): Record<string, unknown> {
  const cleaned = structuredClone(definition) as unknown as Record<string, unknown>;

  if (Array.isArray(cleaned.packageDirectories)) {
    // Build set of unlocked package names — only these are real SF package
    // dependencies. Source/data packages are SFPM-only constructs.
    const unlockedPackages = new Set(
      (cleaned.packageDirectories as PackageDefinition[])
        .filter(pkg => pkg.type === 'unlocked' || !pkg.type)
        .map(pkg => pkg.package),
    );

    cleaned.packageDirectories = (cleaned.packageDirectories as PackageDefinition[]).map(pkgDef => {
      // Strip SFPM-only fields
      const {npmName: _npm, packageOptions: _opts, type: _type, packageId: _id, isOrgDependent, ...rest} = pkgDef;

      const sfPkg: Record<string, unknown> = {...rest};

      // Convert isOrgDependent → orgDependent (SF naming convention)
      if (isOrgDependent) {
        sfPkg.orgDependent = isOrgDependent;
      }

      // Convert flat metadata paths to nested SF format
      if (typeof sfPkg.seedMetadata === 'string') {
        sfPkg.seedMetadata = {path: sfPkg.seedMetadata};
      }

      if (typeof sfPkg.unpackagedMetadata === 'string') {
        sfPkg.unpackagedMetadata = {path: sfPkg.unpackagedMetadata};
      }

      // Filter dependencies to only include unlocked packages and managed deps
      if (Array.isArray(sfPkg.dependencies)) {
        sfPkg.dependencies = (sfPkg.dependencies as PackageDependency[]).filter(
          dep => unlockedPackages.has(dep.package) || !dep.versionNumber,
        );
        if ((sfPkg.dependencies as PackageDependency[]).length === 0) {
          delete sfPkg.dependencies;
        }
      }

      return sfPkg;
    });
  }

  return cleaned;
}

/**
 * Convert raw sfdx-project.json contents into an SFPM ProjectDefinition.
 *
 * Maps SF naming conventions to SFPM conventions:
 * - `orgDependent` → `isOrgDependent`
 * - `seedMetadata: {path}` → `seedMetadata: string`
 * - `unpackagedMetadata: {path}` → `unpackagedMetadata: string`
 *
 * Used by SfdxProjectProvider to produce canonical SFPM types.
 */
export function fromSalesforceProjectJson(projectJson: Record<string, unknown>): ProjectDefinition {
  const result: ProjectDefinition = {
    packageDirectories: [],
    ...(projectJson.namespace !== undefined ? {namespace: projectJson.namespace as string} : {}),
    ...(projectJson.packageAliases ? {packageAliases: projectJson.packageAliases as Record<string, string>} : {}),
    ...(projectJson.sfdcLoginUrl ? {sfdcLoginUrl: projectJson.sfdcLoginUrl as string} : {}),
    ...(projectJson.sourceApiVersion ? {sourceApiVersion: projectJson.sourceApiVersion as string} : {}),
    ...(projectJson.sourceBehaviorOptions ? {sourceBehaviorOptions: projectJson.sourceBehaviorOptions as string[]} : {}),
  };

  if (Array.isArray(projectJson.packageDirectories)) {
    result.packageDirectories = (projectJson.packageDirectories as Record<string, unknown>[])
      .filter(dir => typeof dir.package === 'string' && typeof dir.versionNumber === 'string')
      .map(dir => {
        const {orgDependent, ...rest} = dir;

        const pkgDef: PackageDefinition = {
          package: rest.package as string,
          path: rest.path as string,
          versionNumber: rest.versionNumber as string,
          ...(rest.default ? {default: rest.default as boolean} : {}),
          ...(rest.type ? {type: rest.type as PackageType} : {}),
          ...(rest.npmName ? {npmName: rest.npmName as string} : {}),
          ...(rest.packageId ? {packageId: rest.packageId as string} : {}),
          ...(rest.packageOptions ? {packageOptions: rest.packageOptions as PackageDefinition['packageOptions']} : {}),
          ...(rest.ancestorId ? {ancestorId: rest.ancestorId as string} : {}),
          ...(rest.ancestorVersion ? {ancestorVersion: rest.ancestorVersion as string} : {}),
          ...(rest.definitionFile ? {definitionFile: rest.definitionFile as string} : {}),
          ...(orgDependent ? {isOrgDependent: orgDependent as boolean} : {}),
          ...(rest.scopeProfiles ? {scopeProfiles: rest.scopeProfiles as boolean} : {}),
          ...(rest.versionDescription ? {versionDescription: rest.versionDescription as string} : {}),
        };

        // Convert nested SF metadata paths to flat strings
        if (rest.seedMetadata && typeof rest.seedMetadata === 'object' && 'path' in (rest.seedMetadata as Record<string, unknown>)) {
          pkgDef.seedMetadata = (rest.seedMetadata as {path: string}).path;
        }

        if (rest.unpackagedMetadata && typeof rest.unpackagedMetadata === 'object' && 'path' in (rest.unpackagedMetadata as Record<string, unknown>)) {
          pkgDef.unpackagedMetadata = (rest.unpackagedMetadata as {path: string}).path;
        }

        // Convert dependencies
        if (Array.isArray(rest.dependencies)) {
          pkgDef.dependencies = (rest.dependencies as PackageDependency[]);
        }

        return pkgDef;
      });
  }

  return result;
}
