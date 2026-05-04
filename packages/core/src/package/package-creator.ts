import {Org, SfProject} from '@salesforce/core';
import {Package as SfPackage} from '@salesforce/packaging';
import fs from 'fs-extra';
import EventEmitter from 'node:events';
import path from 'node:path';

import {PackageCreationResult} from '../types/bootstrap.js';
import {Logger} from '../types/logger.js';
import {Package2, PackageService} from './package-service.js';

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
  /** Package name as it appears in sfdx-project.json. */
  name: string;
  /** Relative path to the package directory. */
  path: string;
}

interface PackageCreatorEvents {
  'package:alias:update': [data: {name: string; packageId: string}];
  'package:create:complete': [data: {name: string; packageId: string}];
  'package:create:start': [data: {name: string}];
  'package:query:complete': [data: {existing: string[]; missing: string[]}];
  'package:query:start': [data: {names: string[]}];
}

/**
 * Creates Package2 containers in a DevHub and updates sfdx-project.json aliases.
 *
 * Used by the bootstrap command to ensure Package2 records exist before
 * building package versions.
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
    this.emit('package:create:start', {name: config.name});

    const sfProject = await SfProject.resolve(projectDir);
    const connection = this.org.getConnection();

    const result = await SfPackage.create(connection, sfProject, {
      description: config.description,
      errorNotificationUsername: '',
      name: config.name,
      noNamespace: true,
      orgDependent: config.isOrgDependent,
      packageType: 'Unlocked',
      path: config.path,
    });

    const packageId = result.Id;
    this.logger?.info(`Created package '${config.name}' with Id ${packageId}`);
    this.emit('package:create:complete', {name: config.name, packageId});

    return packageId;
  }

  /**
   * Ensure all packages in the list have Package2 records in the DevHub.
   *
   * For each package:
   * 1. If a matching Package2 already exists → reuse its ID
   * 2. If missing → call `shouldCreate` callback; if approved, create it
   * 3. Update sfdx-project.json aliases in the cloned project directory
   *
   * @param packages - The bootstrap package configs to resolve
   * @param projectDir - Path to the cloned bootstrap project
   * @param shouldCreate - Callback invoked for each missing package; return true to create
   * @returns Array of creation results (created or resolved)
   */
  async ensurePackages(
    packages: PackageCreateConfig[],
    projectDir: string,
    shouldCreate: (name: string) => Promise<boolean>,
  ): Promise<PackageCreationResult[]> {
    const names = packages.map(p => p.name);
    const existing = await this.queryExistingPackages(names);
    const results: PackageCreationResult[] = [];

    // Packages must be processed sequentially — later packages may depend on earlier ones
    /* eslint-disable no-await-in-loop */
    for (const config of packages) {
      const found = existing.get(config.name);

      if (found) {
        this.logger?.info(`Package '${config.name}' already exists (${found.Id})`);
        await this.updateProjectAliases(projectDir, config.name, found.Id);
        results.push({created: false, name: config.name, packageId: found.Id});
        continue;
      }

      const approved = await shouldCreate(config.name);
      if (!approved) {
        throw new Error(`Package '${config.name}' does not exist in the DevHub and creation was declined. `
          + 'Cannot proceed with bootstrap.');
      }

      const packageId = await this.createPackage(config, projectDir);
      await this.updateProjectAliases(projectDir, config.name, packageId);
      results.push({created: true, name: config.name, packageId});
    }
    /* eslint-enable no-await-in-loop */

    return results;
  }

  /**
   * Query the DevHub for existing Package2 records that match the given names.
   * Returns a map of package name → Package2 record for matches found.
   */
  async queryExistingPackages(names: string[]): Promise<Map<string, Package2>> {
    this.emit('package:query:start', {names});

    const service = new PackageService(this.org, this.logger);
    const allPackages = await service.listAllPackages();

    const nameSet = new Set(names);
    const result = new Map<string, Package2>();
    for (const pkg of allPackages) {
      if (nameSet.has(pkg.Name)) {
        result.set(pkg.Name, pkg);
      }
    }

    const existing = [...result.keys()];
    const missing = names.filter(n => !result.has(n));
    this.emit('package:query:complete', {existing, missing});

    this.logger?.debug(`Found ${existing.length} existing package(s), ${missing.length} missing`);
    return result;
  }

  /**
   * Write the packageId into a package's package.json `sfpm.packageId` field.
   *
   * The bootstrap repo ships without packageIds (they are org-specific).
   * After creating or resolving Package2 containers, this method persists
   * the ID so that the downstream workspace provider can pick it up for
   * package version creation.
   */
  async updatePackageConfig(projectDir: string, packagePath: string, packageId: string): Promise<void> {
    const pkgJsonPath = path.join(projectDir, packagePath, 'package.json');
    const pkgJson = await fs.readJson(pkgJsonPath);

    pkgJson.sfpm = pkgJson.sfpm || {};
    pkgJson.sfpm.packageId = packageId;

    await fs.writeJson(pkgJsonPath, pkgJson, {spaces: 2});
    this.logger?.debug(`Updated ${packagePath}/package.json: sfpm.packageId → ${packageId}`);
  }

  /**
   * Read sfdx-project.json from the given project directory, set or update
   * the packageAliases entry for the given package, and write it back.
   */
  async updateProjectAliases(projectDir: string, packageName: string, packageId: string): Promise<void> {
    const projectJsonPath = path.join(projectDir, 'sfdx-project.json');
    const projectJson = await fs.readJson(projectJsonPath);

    projectJson.packageAliases = projectJson.packageAliases || {};
    projectJson.packageAliases[packageName] = packageId;

    await fs.writeJson(projectJsonPath, projectJson, {spaces: 4});
    this.emit('package:alias:update', {name: packageName, packageId});
    this.logger?.debug(`Updated packageAliases: ${packageName} → ${packageId}`);
  }
}
