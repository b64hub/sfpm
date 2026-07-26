import {
  InstallationError,
  type InstallCheckResult,
  type Installer,
  type InstallerResult,
  type Logger,
  PackageType,
  type ProjectDefinitionProvider,
  RegisterInstaller,
  SfpmDataPackage,
  type SfpmPackage,
} from '@b64hub/sfpm-core';
import {Org} from '@salesforce/core';
import fs from 'fs-extra';
import EventEmitter from 'node:events';
import path from 'node:path';

import type {SfdmuExportJson, SfdmuObjectConfig, SfdmuRunOptions} from './types.js';

import SfdmuImportService from './sfdmu-import-service.js';

/**
 * Installer for SFDMU-based data packages.
 *
 * Owns the data-import lifecycle: reads export.json, emits start/complete
 * events, and delegates the CLI invocation to {@link SfdmuImportService}.
 */
// eslint-disable-next-line new-cap
@RegisterInstaller(PackageType.Data)
export default class SfdmuDataInstaller extends EventEmitter implements Installer {
  private readonly logger?: Logger;
  private org?: Org;
  private readonly provider: ProjectDefinitionProvider;
  private readonly service: SfdmuImportService;
  private readonly sfpmPackage: SfpmDataPackage;

  constructor(provider: ProjectDefinitionProvider, sfpmPackage: SfpmPackage, _options?: unknown, logger?: Logger) {
    super();
    if (!(sfpmPackage instanceof SfpmDataPackage)) {
      throw new TypeError(`SfdmuDataInstaller received incompatible package type: ${(sfpmPackage as any).constructor.name}`);
    }

    this.provider = provider;
    this.sfpmPackage = sfpmPackage;
    this.logger = logger;
    this.service = new SfdmuImportService(logger);
  }

  public async connect(targetOrg: Org): Promise<void> {
    this.org = targetOrg;
  }

  public async isInstalled(): Promise<InstallCheckResult> {
    return {installReason: 'not-installed', needsInstall: true};
  }

  public async run(): Promise<InstallerResult> {
    const {packageName} = this.sfpmPackage;
    const targetOrg = this.org!.getUsername()!;

    const dataDir = this.provider.getPackageDir(packageName);
    if (!dataDir) throw new InstallationError(packageName, targetOrg, `Data directory not found for package '${packageName}'`);

    const exportJsonPath = path.join(dataDir, 'export.json');
    const exportJson: SfdmuExportJson = await fs.readJson(exportJsonPath);
    const allObjects = this.extractObjects(exportJson);
    const sObjectNames = allObjects.map(o => o.objectName ?? o.query?.split(/\s+FROM\s+/i)[1]?.split(/\s+/)[0] ?? 'unknown');

    this.emit('data-import:start', {
      objectCount: sObjectNames.length,
      objects: sObjectNames,
      packageName,
      timestamp: new Date(),
    });

    this.logger?.info(`Starting SFDMU import for ${packageName}: ${sObjectNames.length} sObject(s) to ${targetOrg}`);

    const options: SfdmuRunOptions = {
      noprompt: true,
      path: dataDir,
      sourceusername: 'csvfile',
      targetusername: targetOrg,
      ...(exportJson.apiVersion ? {apiVersion: exportJson.apiVersion} : {}),
    };

    try {
      const result = await this.service.run(options, packageName);

      this.emit('data-import:complete', {
        duration: result.duration,
        objectsProcessed: result.objectsProcessed,
        packageName,
        success: result.success,
        timestamp: new Date(),
      });

      if (!result.success) {
        const failedObjects = result.objectResults
        .filter(r => !r.success)
        .map(r => `${r.objectName}: ${r.errorMessage}`)
        .join('; ');
        throw new InstallationError(packageName, targetOrg, `SFDMU import failed for: ${failedObjects}`, {
          cause: new Error(failedObjects),
        });
      }

      this.logger?.info(`SFDMU import completed for ${packageName} in ${result.duration}ms`);
      return {};
    } catch (error) {
      if (error instanceof InstallationError) throw error;
      throw new InstallationError(
        packageName,
        targetOrg,
        `SFDMU import failed: ${error instanceof Error ? error.message : String(error)}`,
        {cause: error instanceof Error ? error : new Error(String(error))},
      );
    }
  }

  private extractObjects(exportJson: SfdmuExportJson): SfdmuObjectConfig[] {
    if (exportJson.objects && Array.isArray(exportJson.objects)) return exportJson.objects;
    if (exportJson.objectSets && Array.isArray(exportJson.objectSets)) {
      return exportJson.objectSets.flatMap(set => set.objects ?? []);
    }

    return [];
  }
}
