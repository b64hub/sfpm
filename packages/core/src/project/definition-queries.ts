/**
 * Pure utility functions that derive package/dependency information from a
 * ProjectDefinition. Used by both WorkspaceProvider and
 * SfdxProjectProvider to implement the query portion of
 * ProjectDefinitionProvider without duplication.
 */

import type {ClassifiedDependencies, PackageDependency} from './project-definition-provider.js';

import {PackageType} from '../types/package.js';
import {
  ManagedPackageDefinition,
  PackageDefinition,
  ProjectDefinition,
  SUBSCRIBER_PKG_VERSION_ID_PREFIX,
} from '../types/project.js';

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
