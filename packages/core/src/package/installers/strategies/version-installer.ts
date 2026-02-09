import {Connection, Org} from '@salesforce/core';
import {EventEmitter} from 'node:events';

import {Logger} from '../../../types/logger.js';
import {type VersionInstallable} from '../types.js';

type PackageInstallRequest = {
  Errors?: {errors: Array<{message: string}>};
  Id: string;
  Status: string;
  SubscriberPackageVersionKey: string;
};

/**
 * Installs a package by subscriber version ID (04t) via the Tooling API.
 *
 * This is a pure strategy — it knows nothing about SfpmPackage or routing.
 * The caller (an installer acting as adapter) is responsible for building the
 * {@link VersionInstallable} payload and deciding when this strategy applies.
 */
export default class VersionInstaller {
  private eventEmitter?: EventEmitter;
  private logger?: Logger;

  constructor(logger?: Logger, eventEmitter?: EventEmitter) {
    this.logger = logger;
    this.eventEmitter = eventEmitter;
  }

  public async install(installable: VersionInstallable, targetOrg: string): Promise<void> {
    const {installationKey, packageName, packageVersionId} = installable;

    if (!packageVersionId) {
      throw new Error(`Package version ID not found for: ${packageName}`);
    }

    this.logger?.info(`Using version install strategy for package: ${packageName}`);
    this.logger?.info(`Installing package version ${packageVersionId} to ${targetOrg}`);

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
      packageName,
      timestamp: new Date(),
      versionId: packageVersionId,
    });

    const installRequest = {
      ApexCompileType: 'package',
      NameConflictResolution: 'Block',
      Password: installationKey || '',
      SecurityType: 'Full',
      SubscriberPackageVersionKey: packageVersionId,
    };

    const result = await connection.tooling.create('PackageInstallRequest', installRequest);

    if (!result.success || !result.id) {
      throw new Error(`Failed to create package install request: ${JSON.stringify(result.errors || [])}`);
    }

    const requestId = result.id as string;

    // Poll for installation status
    const installStatus = await this.pollInstallStatus(connection, requestId, packageName);

    if (installStatus.Status !== 'SUCCESS') {
      const errors = installStatus.Errors?.errors?.map(e => e.message).join('\n') || 'Unknown installation error';
      throw new Error(`Package installation failed:\n${errors}`);
    }

    // Emit version-install complete event
    this.eventEmitter?.emit('version-install:complete', {
      packageName,
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
