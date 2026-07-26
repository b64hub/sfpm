import {Org} from '@salesforce/core';
import EventEmitter from 'node:events';

import type {ProjectDefinitionProvider} from '../project/providers/project-definition-provider.js';
import type {Package2} from './package-service.js';

import Logger from '../types/logger.js';
import {stripScope} from '../utils/scope-utils.js';
import PackageManager, {type PackageCreateConfig, type PackageCreationResult} from './package-manager.js';

interface PackageCreatorEvents {
  'package:create:complete': [data: {name: string; packageId: string}];
  'package:create:start': [data: {name: string}];
  'package:query:complete': [data: {existing: string[]; missing: string[]}];
  'package:query:start': [data: {names: string[]}];
}

/**
 * @deprecated Use {@link PackageManager} directly.
 *
 * Creates Package2 containers in a DevHub and persists the resulting
 * packageId back through the ProjectDefinitionProvider.
 *
 * All functionality has moved to {@link PackageManager}:
 * - `createPackage`      → {@link PackageManager.createPackageFromConfig}
 * - `queryExistingPackages` → {@link PackageManager.queryExistingPackages}
 * - `ensurePackages`     → {@link PackageManager.ensurePackages}
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
   * @deprecated Use {@link PackageManager.createPackageFromConfig}.
   */
  async createPackage(config: PackageCreateConfig, projectDir: string): Promise<string> {
    const sfName = stripScope(config.name);
    this.emit('package:create:start', {name: sfName});
    const packageId = await PackageManager.getInstance(this.org, this.logger).createPackageFromConfig(config, projectDir);
    this.emit('package:create:complete', {name: sfName, packageId});
    return packageId;
  }

  /**
   * @deprecated Use {@link PackageManager.ensurePackages}.
   */
  async ensurePackages(
    packages: PackageCreateConfig[],
    provider: ProjectDefinitionProvider,
    projectDir: string,
    shouldCreate: (name: string) => Promise<boolean>,
  ): Promise<PackageCreationResult[]> {
    return PackageManager.getInstance(this.org, this.logger).ensurePackages(packages, provider, projectDir, shouldCreate);
  }

  /**
   * @deprecated Use {@link PackageManager.queryExistingPackages}.
   */
  async queryExistingPackages(names: string[]): Promise<Map<string, Package2>> {
    const sfNames = names.map(n => stripScope(n));
    this.emit('package:query:start', {names: sfNames});
    const result = await PackageManager.getInstance(this.org, this.logger).queryExistingPackages(names);
    const existing = [...result.keys()];
    const missing = sfNames.filter(n => !result.has(n));
    this.emit('package:query:complete', {existing, missing});
    this.logger?.debug(`Found ${existing.length} existing package(s), ${missing.length} missing`);
    return result;
  }
}

export {type PackageCreateConfig, type PackageCreationResult} from './package-manager.js';
