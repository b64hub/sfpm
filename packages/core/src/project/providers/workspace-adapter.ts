/**
 * Adapter for converting between workspace package.json files and
 * SFPM PackageDefinition structures.
 *
 * - Read:  WorkspacePackageJson → PackageDefinition (used by WorkspaceProvider)
 * - Write: PackageDefinition → WorkspacePackageJson (used by WorkspaceInitializer)
 */

import path from 'node:path';

import type {PackageType} from '../../types/package.js';
import type {PackageDefinition, ProjectDefinition} from '../../types/project.js';
import type {SfpmPackageConfig, WorkspacePackageJson} from './types/workspace.js';

// ---------------------------------------------------------------------------
// WorkspacePackageJson → PackageDefinition
// ---------------------------------------------------------------------------

/**
 * Convert a workspace package.json into an SFPM PackageDefinition.
 *
 * @param pkgJson           - The workspace member's package.json
 * @param packageDir        - Relative path from project root to the package directory (e.g., "packages/core")
 * @param workspaceVersions - Map of workspace package names → versions (for resolving dep version numbers)
 * @returns A PackageDefinition
 */
export function toPackageDefinition(
  pkgJson: WorkspacePackageJson,
  packageDir: string,
  workspaceVersions?: Map<string, string>,
): PackageDefinition {
  const {sfpm} = pkgJson;

  // Build the path by combining the package directory with the SF source path
  const sourcePath = path.posix.join(packageDir, sfpm.path ?? '.');

  const definition: PackageDefinition = {
    name: pkgJson.name,
    path: sourcePath,
    type: sfpm.packageType as PackageType,
    version: pkgJson.version,
  };

  if (pkgJson.description) {
    definition.description = pkgJson.description;
  }

  if (sfpm.packageOptions) {
    definition.packageOptions = sfpm.packageOptions;
  }

  if (sfpm.packageId) {
    definition.packageId = sfpm.packageId;
  }

  // Build dependencies record from workspace: deps
  const dependencies = buildDependenciesRecord(pkgJson, workspaceVersions);
  if (Object.keys(dependencies).length > 0) {
    definition.dependencies = dependencies;
  }

  // Copy managed dependencies directly
  if (pkgJson.managedDependencies && Object.keys(pkgJson.managedDependencies).length > 0) {
    definition.managedDependencies = {...pkgJson.managedDependencies};
  }

  // Resolve metadata dependencies relative to the package directory
  if (pkgJson.metadataDependencies) {
    const md: {seed?: string; unpackaged?: string} = {};
    if (pkgJson.metadataDependencies.seed) {
      md.seed = path.posix.join(packageDir, pkgJson.metadataDependencies.seed);
    }

    if (pkgJson.metadataDependencies.unpackaged) {
      md.unpackaged = path.posix.join(packageDir, pkgJson.metadataDependencies.unpackaged);
    }

    if (md.seed || md.unpackaged) {
      definition.metadataDependencies = md as {seed: string; unpackaged: string};
    }
  }

  return definition;
}

// ---------------------------------------------------------------------------
// PackageDefinition → WorkspacePackageJson
// ---------------------------------------------------------------------------

export interface ToWorkspacePackageJsonOptions {
  /** npm scope to prepend to unscoped package names (e.g., "@myorg") */
  npmScope: string;
}

/**
 * Convert a PackageDefinition back into a WorkspacePackageJson.
 *
 * Used during migration from sfdx-project.json to workspace mode.
 * Inverse of {@link toPackageDefinition}.
 *
 * @param pkgDef      - The SFPM PackageDefinition
 * @param packageDir  - Relative path from project root to the target package directory
 * @param sourcePath  - SF source path relative to the package directory (e.g., "force-app" or ".")
 * @param packageType - Resolved package type
 * @param options     - Conversion options (npm scope, etc.)
 * @param projectDef  - Full project definition for resolving internal vs external dependencies
 */
export function toWorkspacePackageJson(
  pkgDef: PackageDefinition,
  packageDir: string,
  sourcePath: string,
  packageType: Exclude<PackageType, 'managed'>,
  options: ToWorkspacePackageJsonOptions,
  projectDef: ProjectDefinition,
): WorkspacePackageJson {
  const packageName = pkgDef.name;
  const version = pkgDef.version;

  const sfpm: SfpmPackageConfig = {
    packageType,
    // Only set path when source lives in a subdirectory (not at package root)
    ...(sourcePath === '.' ? {} : {path: sourcePath}),
  };

  if (pkgDef.packageId) {
    sfpm.packageId = pkgDef.packageId;
  }

  if (pkgDef.packageOptions) {
    sfpm.packageOptions = pkgDef.packageOptions;
  }

  // Resolve metadataDependencies paths relative to package dir
  let metadataDependencies: {seed?: string; unpackaged?: string} | undefined;
  if (pkgDef.metadataDependencies) {
    const md: {seed?: string; unpackaged?: string} = {};
    if (pkgDef.metadataDependencies.seed) {
      md.seed = path.posix.relative(packageDir, pkgDef.metadataDependencies.seed) || pkgDef.metadataDependencies.seed;
    }

    if (pkgDef.metadataDependencies.unpackaged) {
      md.unpackaged = path.posix.relative(packageDir, pkgDef.metadataDependencies.unpackaged) || pkgDef.metadataDependencies.unpackaged;
    }

    if (md.seed || md.unpackaged) {
      metadataDependencies = md;
    }
  }

  // Build workspace dependencies from SFPM dependencies
  const dependencies: Record<string, string> = {};
  const projectPackageNames = new Set(projectDef.packages.map(p => p.name));

  if (pkgDef.dependencies) {
    for (const [depName, depVersion] of Object.entries(pkgDef.dependencies)) {
      if (projectPackageNames.has(depName)) {
        dependencies[depName.includes('/') ? depName : `${options.npmScope}/${depName}`] = `workspace:^${depVersion.replace(/^[\^~]/, '')}`;
      }
    }
  }

  const pkgJson: WorkspacePackageJson = {
    ...(pkgDef.description ? {description: pkgDef.description} : {}),
    ...(pkgDef.managedDependencies && Object.keys(pkgDef.managedDependencies).length > 0
      ? {managedDependencies: pkgDef.managedDependencies} : {}),
    ...(metadataDependencies ? {metadataDependencies} : {}),
    name: packageName.includes('/') ? packageName : `${options.npmScope}/${packageName}`,
    private: true,
    scripts: {
      'sfpm:build': `sfpm build ${packageName} --turbo`,
      'sfpm:deploy': `sfpm deploy ${packageName} --turbo`,
      'sfpm:install': `sfpm install ${packageName} --turbo`,
    },
    sfpm,
    version,
  };

  if (Object.keys(dependencies).length > 0) {
    pkgJson.dependencies = dependencies;
  }

  return pkgJson;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build a dependencies record from workspace: dependencies in package.json.
 *
 * Workspace deps (workspace:^x.y.z) become `{name: version}` entries
 * using the depended-on package's actual version from the workspace.
 */
function buildDependenciesRecord(
  pkgJson: WorkspacePackageJson,
  workspaceVersions?: Map<string, string>,
): Record<string, string> {
  const deps: Record<string, string> = {};

  if (!pkgJson.dependencies) return deps;

  for (const [depName, version] of Object.entries(pkgJson.dependencies)) {
    // Only include workspace: dependencies (local SF packages)
    if (typeof version === 'string' && version.startsWith('workspace:')) {
      const depVersion = workspaceVersions?.get(depName);
      deps[depName] = depVersion ? `^${depVersion.split('-')[0]}` : '*';
    }
  }

  return deps;
}
