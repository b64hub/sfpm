import {Connection, Org} from '@salesforce/core';
import {EventEmitter} from 'node:events';

import {Logger} from '../../../types/logger.js';
import {InstallationMode, InstallationSource, SfpmUnlockedPackageBuildOptions} from '../../../types/package.js';
import SfpmPackage, {SfpmManagedPackage, SfpmUnlockedPackage} from '../../sfpm-package.js';
import {InstallationStrategy} from '../installation-strategy.js';

type PackageInstallRequest = {
  Errors?: {errors: Array<{message: string}>};
  Id: string;
  Status: string;
  SubscriberPackageVersionKey: string;
};

/**
 * Strategy for installing a package by subscriber version ID (04t) via the Tooling API.
 * Applicable for:
 * - Unlocked packages with a packageVersionId from a built artifact
 * - Managed packages (always have a packageVersionId from packageAliases)
 */
export default class VersionInstallStrategy implements InstallationStrategy {
  private eventEmitter?: EventEmitter;
  private logger?: Logger;

  constructor(logger?: Logger, eventEmitter?: EventEmitter) {
    this.logger = logger;
    this.eventEmitter = eventEmitter;
  }

  public canHandle(source: InstallationSource, sfpmPackage: SfpmPackage): boolean {
    // Managed packages always use version install
    if (sfpmPackage instanceof SfpmManagedPackage) {
      return true;
    }

    // Unlocked packages: requires artifact source + packageVersionId
    if (sfpmPackage instanceof SfpmUnlockedPackage) {
      const hasVersionId = Boolean(sfpmPackage.packageVersionId);
      const isArtifactSource = source === InstallationSource.Artifact;
      return hasVersionId && isArtifactSource;
    }

    return false;
  }

  public getMode(): InstallationMode {
    return InstallationMode.VersionInstall;
  }

  public async install(sfpmPackage: SfpmPackage, targetOrg: string): Promise<void> {
    // Extract versionId from either SfpmUnlockedPackage or SfpmManagedPackage
    let versionId: string | undefined;
    if (sfpmPackage instanceof SfpmManagedPackage) {
      versionId = sfpmPackage.packageVersionId;
    } else if (sfpmPackage instanceof SfpmUnlockedPackage) {
      versionId = sfpmPackage.packageVersionId;
    }

    if (!versionId) {
      throw new Error(`Package version ID not found for: ${sfpmPackage.packageName}`);
    }

    this.logger?.info(`Using version install strategy for package: ${sfpmPackage.packageName}`);

    // Get installation key from package metadata if available (unlocked packages only)
    let installationKey: string | undefined;
    if (sfpmPackage instanceof SfpmUnlockedPackage) {
      const buildOptions = sfpmPackage.metadata?.orchestration?.buildOptions as SfpmUnlockedPackageBuildOptions | undefined;
      installationKey = buildOptions?.installationkey;
    }

    this.logger?.info(`Installing package version ${versionId} to ${targetOrg}`);

    // Connect to target org
    const org = await Org.create({aliasOrUsername: targetOrg});
    const connection = org.getConnection();

    if (!connection) {
      throw new Error(`Unable to connect to org: ${targetOrg}`);
    }

    // Create package install request using Tooling API
    this.logger?.info('Starting package installation...');

    // Emit version-install start event
    this.eventEmitter?.emit('version-install:start', {
      packageName: sfpmPackage.packageName,
      timestamp: new Date(),
      versionId,
    });

    const installRequest = {
      ApexCompileType: 'package',
      NameConflictResolution: 'Block',
      Password: installationKey || '',
      SecurityType: 'Full',
      SubscriberPackageVersionKey: versionId,
    };

    const result = await connection.tooling.create('PackageInstallRequest', installRequest);

    if (!result.success || !result.id) {
      throw new Error(`Failed to create package install request: ${JSON.stringify(result.errors || [])}`);
    }

    const requestId = result.id as string;

    // Poll for installation status
    const installStatus = await this.pollInstallStatus(connection, requestId, sfpmPackage.packageName);

    if (installStatus.Status !== 'SUCCESS') {
      const errors = installStatus.Errors?.errors?.map(e => e.message).join('\n') || 'Unknown installation error';
      throw new Error(`Package installation failed:\n${errors}`);
    }

    // Emit version-install complete event
    this.eventEmitter?.emit('version-install:complete', {
      packageName: sfpmPackage.packageName,
      success: true,
      timestamp: new Date(),
    });

    this.logger?.info('Package installation completed successfully');
  }

  private async pollInstallStatus(connection: Connection, requestId: string, packageName: string): Promise<PackageInstallRequest> {
    const maxAttempts = 120; // 10 minutes with 5 second intervals
    let attempts = 0;

    while (attempts < maxAttempts) {
      const record = await connection.tooling.retrieve('PackageInstallRequest', requestId);

      if (!record) {
        throw new Error(`Could not retrieve PackageInstallRequest: ${requestId}`);
      }

      const status = (record as any).Status;
      this.logger?.info(`Installation status: ${status}`);

      // Emit progress event
      this.eventEmitter?.emit('version-install:progress', {
        attempt: attempts + 1,
        maxAttempts,
        packageName,
        status,
        timestamp: new Date(),
      });

      if (status === 'SUCCESS' || status === 'ERROR') {
        return record as PackageInstallRequest;
      }

      // Wait 5 seconds before next poll
      await new Promise(resolve => setTimeout(resolve, 5000));
      attempts++;
    }

    throw new Error(`Package installation timed out after ${maxAttempts * 5} seconds`);
  }
}
