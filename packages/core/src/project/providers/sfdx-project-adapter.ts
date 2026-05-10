/**
 * Adapter for converting between SFPM's canonical ProjectDefinition and
 * Salesforce's sfdx-project.json format.
 *
 * - Write: ProjectDefinition → sfdx-project.json (for disk writes / @salesforce/core)
 * - Read:  sfdx-project.json → ProjectDefinition (for legacy mode)
 */

import type {PackageType} from '../../types/package.js';
import type {PackageDefinition, ProjectDefinition} from '../../types/project.js';

import {SUBSCRIBER_PKG_VERSION_ID_PREFIX} from '../../types/project.js';
import {stripScope} from '../../utils/scope-utils.js';
import {toSalesforceVersionWithToken} from '../../utils/version-utils.js';

// ---------------------------------------------------------------------------
// ProjectDefinition → sfdx-project.json
// ---------------------------------------------------------------------------

/**
 * Convert a ProjectDefinition into sfdx-project.json format.
 *
 * Maps SFPM canonical types to Salesforce CLI conventions:
 * - `.name` → `.package` (scope stripped)
 * - `.version` → `.versionNumber` (semver → 4-part SF format)
 * - `.packages` → `packageDirectories`
 * - Per-package `managedDependencies` + `packageId` → top-level `packageAliases`
 * - `dependencies` record → `dependencies` array of `{package, versionNumber}`
 *
 * Strips SFPM-specific fields that Salesforce CLI doesn't understand.
 */
export function toSalesforceProjectJson(definition: ProjectDefinition): Record<string, unknown> {
  // Build set of unlocked package names — only these are real SF package
  // dependencies. Source/data packages are SFPM-only constructs.
  const unlockedPackageNames = new Set(definition.packages
  .filter(pkg => pkg.type === 'unlocked' || !pkg.type)
  .map(pkg => stripScope(pkg.name)));

  const packageAliases: Record<string, string> = {};
  const packageDirectories: Record<string, unknown>[] = [];

  for (const pkgDef of definition.packages) {
    const sfName = stripScope(pkgDef.name);
    const sfVersion = toSalesforceVersionWithToken(pkgDef.version, pkgDef.type as Exclude<PackageType, 'managed'>);

    const sfPkg: Record<string, unknown> = {
      package: sfName,
      path: pkgDef.path,
      versionNumber: sfVersion,
    };

    if (pkgDef.default) {
      sfPkg.default = true;
    }

    if (pkgDef.description) {
      sfPkg.versionDescription = pkgDef.description;
    }

    if (pkgDef.namespace) {
      sfPkg.namespace = pkgDef.namespace;
    }

    // Build SF dependencies array from workspace deps + managed deps
    const sfDeps: Array<{package: string; versionNumber?: string}> = [];

    if (pkgDef.dependencies) {
      for (const [depName, depVersion] of Object.entries(pkgDef.dependencies)) {
        const sfDepName = stripScope(depName);
        // Only include unlocked packages in SF deps
        if (unlockedPackageNames.has(sfDepName)) {
          // Convert semver constraint to SF format: ^1.2.3 → 1.2.3.LATEST
          const cleanVersion = depVersion.replace(/^[\^~]/, '');
          sfDeps.push({package: sfDepName, versionNumber: `${cleanVersion}.LATEST`});
        }
      }
    }

    // Add managed deps as unversioned references
    if (pkgDef.managedDependencies) {
      for (const alias of Object.keys(pkgDef.managedDependencies)) {
        sfDeps.push({package: alias});
      }
    }

    if (sfDeps.length > 0) {
      sfPkg.dependencies = sfDeps;
    }

    // Convert metadata dependencies to nested SF format
    if (pkgDef.metadataDependencies?.seed) {
      sfPkg.seedMetadata = {path: pkgDef.metadataDependencies.seed};
    }

    if (pkgDef.metadataDependencies?.unpackaged) {
      sfPkg.unpackagedMetadata = {path: pkgDef.metadataDependencies.unpackaged};
    }

    packageDirectories.push(sfPkg);

    // Collect packageAliases from per-package packageId and managedDependencies
    if (pkgDef.packageId) {
      packageAliases[sfName] = pkgDef.packageId;
    }

    if (pkgDef.managedDependencies) {
      for (const [alias, versionId] of Object.entries(pkgDef.managedDependencies)) {
        packageAliases[alias] = versionId;
      }
    }
  }

  const result: Record<string, unknown> = {
    packageDirectories,
    ...(definition.sfdcLoginUrl ? {sfdcLoginUrl: definition.sfdcLoginUrl} : {}),
    ...(definition.sourceApiVersion ? {sourceApiVersion: definition.sourceApiVersion} : {}),
    ...(definition.sourceBehaviorOptions?.length ? {sourceBehaviorOptions: definition.sourceBehaviorOptions} : {}),
  };

  if (Object.keys(packageAliases).length > 0) {
    result.packageAliases = packageAliases;
  }

  return result;
}

// ---------------------------------------------------------------------------
// sfdx-project.json → ProjectDefinition
// ---------------------------------------------------------------------------

/**
 * Convert raw sfdx-project.json contents into an SFPM ProjectDefinition.
 *
 * Maps SF naming conventions to SFPM conventions:
 * - `packageDirectories` → `packages`
 * - `package` → `name` (no scope available from SF file — kept as-is)
 * - `versionNumber` → `version` (4-part → semver: 1.0.0.NEXT → 1.0.0, 1.0.0.5 → 1.0.0-5)
 * - `dependencies` array → `dependencies` record `{name: version}`
 * - `packageAliases` → per-package `managedDependencies` (non-local deps with 04t IDs)
 *
 * Used by SfdxProjectProvider to produce canonical SFPM types.
 */
export function fromSalesforceProjectJson(projectJson: Record<string, unknown>): ProjectDefinition {
  const packageAliases = (projectJson.packageAliases ?? {}) as Record<string, string>;

  const result: ProjectDefinition = {
    packages: [],
    ...(projectJson.sfdcLoginUrl ? {sfdcLoginUrl: projectJson.sfdcLoginUrl as string} : {}),
    ...(projectJson.sourceApiVersion ? {sourceApiVersion: projectJson.sourceApiVersion as string} : {}),
    ...(projectJson.sourceBehaviorOptions ? {sourceBehaviorOptions: projectJson.sourceBehaviorOptions as string[]} : {}),
  };

  if (!Array.isArray(projectJson.packageDirectories)) return result;

  // Build set of local package names for classifying dependencies
  const localPackageNames = new Set((projectJson.packageDirectories as Record<string, unknown>[])
  .filter(dir => typeof dir.package === 'string')
  .map(dir => dir.package as string));

  result.packages = (projectJson.packageDirectories as Record<string, unknown>[])
  .filter(dir => typeof dir.package === 'string' && typeof dir.versionNumber === 'string')
  .map(dir => {
    const sfName = dir.package as string;
    const sfVersion = dir.versionNumber as string;

    // Convert SF 4-part version to semver
    const versionParts = sfVersion.split('.');
    const semverBase = versionParts.slice(0, 3).join('.');
    const buildSegment = versionParts[3];
    let version = semverBase;
    if (buildSegment && buildSegment !== 'NEXT' && buildSegment !== '0') {
      version = `${semverBase}-${buildSegment}`;
    }

    const pkgDef: PackageDefinition = {
      name: sfName,
      path: dir.path as string,
      type: (dir.type as PackageType) ?? 'unlocked',
      version,
    };

    if (dir.default) {
      pkgDef.default = true;
    }

    if (dir.versionDescription) {
      pkgDef.description = dir.versionDescription as string;
    }

    if (dir.namespace) {
      pkgDef.namespace = dir.namespace as string;
    }

    if (dir.packageOptions) {
      pkgDef.packageOptions = {...pkgDef.packageOptions, ...dir.packageOptions as Record<string, unknown>};
    }

    // Look up packageId from packageAliases
    const aliasId = packageAliases[sfName];
    if (aliasId && !aliasId.startsWith(SUBSCRIBER_PKG_VERSION_ID_PREFIX)) {
      pkgDef.packageId = aliasId;
    }

    // Convert dependencies array to records
    if (Array.isArray(dir.dependencies)) {
      const deps: Record<string, string> = {};
      const managedDeps: Record<string, string> = {};

      for (const dep of dir.dependencies as Array<{package: string; versionNumber?: string}>) {
        // Check for managed dependency first — a 04t alias always wins,
        // even if the name matches a local packageDirectory stub.
        const aliasValue = packageAliases[dep.package];
        if (aliasValue?.startsWith(SUBSCRIBER_PKG_VERSION_ID_PREFIX) && !localPackageNames.has(dep.package)) {
          managedDeps[dep.package] = aliasValue;
        } else if (localPackageNames.has(dep.package)) {
          // Local workspace dependency
          deps[dep.package] = dep.versionNumber
            ? `^${dep.versionNumber.split('.').slice(0, 3).join('.')}`
            : '*';
        }
      }

      if (Object.keys(deps).length > 0) {
        pkgDef.dependencies = deps;
      }

      if (Object.keys(managedDeps).length > 0) {
        pkgDef.managedDependencies = managedDeps;
      }
    }

    // Convert nested SF metadata paths to metadataDependencies
    const md: {seed?: string; unpackaged?: string} = {};
    if (dir.seedMetadata && typeof dir.seedMetadata === 'object' && 'path' in (dir.seedMetadata as Record<string, unknown>)) {
      md.seed = (dir.seedMetadata as {path: string}).path;
    }

    if (dir.unpackagedMetadata && typeof dir.unpackagedMetadata === 'object' && 'path' in (dir.unpackagedMetadata as Record<string, unknown>)) {
      md.unpackaged = (dir.unpackagedMetadata as {path: string}).path;
    }

    if (md.seed || md.unpackaged) {
      pkgDef.metadataDependencies = md as {seed?: string; unpackaged?: string};
    }

    return pkgDef;
  });

  return result;
}
