import {Org, SfProject} from '@salesforce/core';
import {Package as SfPackage} from '@salesforce/packaging';
import EventEmitter from 'node:events';

import type {ProjectDefinitionProvider} from '../project/providers/project-definition-provider.js';

import {Logger} from '../types/logger.js';
import {stripScope} from '../utils/scope-utils.js';
import {Package2, PackageService} from './package-service.js';

/**
 * Result of attempting to create or resolve a single Package2 container in the DevHub.
 */
export interface PackageCreationResult {
  /** Whether the package was freshly created (false = already existed). */
  created: boolean;
  /** The Package2 name. */
  name: string;
  /** The Package2 Id (0Ho prefix). */
  packageId: string;
}

/**
 * Configuration for creating a Package2 container in a DevHub.
 *
 * This is the generic contract — callers provide these fields regardless of
 * whether the package is part of bootstrap, a new workspace package, or
 * anything else.
 */
export interface PackageCreateConfig {
  /** Human-readable description of the package. */
  description: string;
  /** Whether this is an org-dependent unlocked package. */
  isOrgDependent: boolean;
  /** Package name (may include npm scope). Scope is stripped for DevHub operations. */
  name: string;
  /** Relative path to the package directory. */
  path: string;
}

interface PackageCreatorEvents {
  'package:create:complete': [data: {name: string; packageId: string}];
  'package:create:start': [data: {name: string}];
  'package:query:complete': [data: {existing: string[]; missing: string[]}];
  'package:query:start': [data: {names: string[]}];
}

/**
 * Creates Package2 containers in a DevHub and persists the resulting
 * packageId back through the ProjectDefinitionProvider.
 *
 * Agnostic to the backing store — the provider handles whether packageId
 * is written to sfdx-project.json, workspace package.json, or both.
 */
export class PackageCreator extends EventEmitter<PackageCreatorEvents> {
  private logger?: Logger;
  private org: Org;

  constructor(org: Org, logger?: Logger) {
    super();
    this.org = org;
    this.logger = logger;
  }

  /**
   * Create a Package2 record in the DevHub for the given bootstrap package config.
   * Returns the new package ID.
   */
  async createPackage(config: PackageCreateConfig, projectDir: string): Promise<string> {
    const sfName = stripScope(config.name);
    this.emit('package:create:start', {name: sfName});

    const sfProject = await SfProject.resolve(projectDir);
    const connection = this.org.getConnection();

    const result = await SfPackage.create(connection, sfProject, {
      description: config.description,
      errorNotificationUsername: '',
      name: sfName,
      noNamespace: true,
      orgDependent: config.isOrgDependent,
      packageType: 'Unlocked',
      path: config.path,
    });

    const packageId = result.Id;
    this.logger?.info(`Created package '${sfName}' with Id ${packageId}`);
    this.emit('package:create:complete', {name: sfName, packageId});

    return packageId;
  }

  /**
   * Ensure all packages in the list have Package2 records in the DevHub.
   *
   * For each package:
   * 1. If a matching Package2 already exists → reuse its ID
   * 2. If missing → call `shouldCreate` callback; if approved, create it
   * 3. Persist the packageId via the ProjectDefinitionProvider
   *
   * @param packages - The bootstrap package configs to resolve
   * @param provider - Provider to persist packageId updates
   * @param projectDir - Path to the project (for SfProject resolution)
   * @param shouldCreate - Callback invoked for each missing package; return true to create
   * @returns Array of creation results (created or resolved)
   */
  async ensurePackages(
    packages: PackageCreateConfig[],
    provider: ProjectDefinitionProvider,
    projectDir: string,
    shouldCreate: (name: string) => Promise<boolean>,
  ): Promise<PackageCreationResult[]> {
    const names = packages.map(p => p.name);
    const existing = await this.queryExistingPackages(names);
    const results: PackageCreationResult[] = [];

    // Packages must be processed sequentially — later packages may depend on earlier ones
    /* eslint-disable no-await-in-loop */
    for (const config of packages) {
      const sfName = stripScope(config.name);
      const found = existing.get(sfName);

      if (found) {
        this.logger?.info(`Package '${sfName}' already exists (${found.Id})`);
        await provider.updatePackageConfig(config.name, {packageId: found.Id});
        results.push({created: false, name: sfName, packageId: found.Id});
        continue;
      }

      const approved = await shouldCreate(sfName);
      if (!approved) {
        throw new Error(`Package '${sfName}' does not exist in the DevHub and creation was declined. `
          + 'Cannot proceed with bootstrap.');
      }

      const packageId = await this.createPackage(config, projectDir);
      await provider.updatePackageConfig(config.name, {packageId});
      results.push({created: true, name: sfName, packageId});
    }
    /* eslint-enable no-await-in-loop */

    return results;
  }

  /**
   * Query the DevHub for existing Package2 records that match the given names.
   * Returns a map of package name → Package2 record for matches found.
   */
  async queryExistingPackages(names: string[]): Promise<Map<string, Package2>> {
    const sfNames = names.map(n => stripScope(n));
    this.emit('package:query:start', {names: sfNames});

    const service = new PackageService(this.org, this.logger);
    const allPackages = await service.listAllPackages();

    const nameSet = new Set(sfNames);
    const result = new Map<string, Package2>();
    for (const pkg of allPackages) {
      if (nameSet.has(pkg.Name)) {
        result.set(pkg.Name, pkg);
      }
    }

    const existing = [...result.keys()];
    const missing = sfNames.filter(n => !result.has(n));
    this.emit('package:query:complete', {existing, missing});

    this.logger?.debug(`Found ${existing.length} existing package(s), ${missing.length} missing`);
    return result;
  }
}
