import {Connection, Org} from '@salesforce/core';

import type {InstallEventSink} from '../../../events/install-event-bus.js';

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
  private logger?: Logger;
  private sink?: InstallEventSink;

  constructor(logger?: Logger, sink?: InstallEventSink) {
    this.logger = logger;
    this.sink = sink;
  }

  public async install(installable: VersionInstallable, targetOrg: string): Promise<{deployId?: string}> {
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

    this.logger?.info('Starting package installation...');
    this.sink?.versionStart({packageVersionId});

    const requestId = await this.createInstallRequest(connection, packageVersionId, installationKey, packageName);

    try {
      const installStatus = await this.pollInstallStatus(connection, requestId, packageName);

      if (installStatus.Status !== 'SUCCESS') {
        const errors = installStatus.Errors?.errors?.map(e => e.message).join('\n') || 'Unknown installation error';
        throw new Error(`Package installation failed:\n${errors}`);
      }
    } catch (error) {
      await this.handleInstallFailure(error, requestId, packageName, targetOrg);
      // handleInstallFailure returns normally only on successful recovery
    }

    this.sink?.versionComplete({packageVersionId});
    this.logger?.info('Package installation completed successfully');

    return {deployId: requestId};
  }

  /**
   * Create a PackageInstallRequest via the Tooling API. Returns the request ID.
   */
  private async createInstallRequest(
    connection: Connection,
    packageVersionId: string,
    installationKey: string | undefined,
    packageName: string,
  ): Promise<string> {
    const installRequest = {
      ApexCompileType: 'package',
      NameConflictResolution: 'Block',
      Password: installationKey || '',
      SecurityType: 'Full',
      SubscriberPackageVersionKey: packageVersionId,
    };

    const result = await connection.tooling.create('PackageInstallRequest', installRequest);

    if (!result.success || !result.id) {
      throw new Error(`Failed to create package install request for ${packageName}: ${JSON.stringify(result.errors || [])}`);
    }

    return result.id as string;
  }

  private async pollInstallStatus(connection: Connection, requestId: string, packageName: string): Promise<PackageInstallRequest> {
    const maxAttempts = 120; // 10 minutes with 5 second intervals
    let attempts = 0;

    while (attempts < maxAttempts) {
      // eslint-disable-next-line no-await-in-loop
      const record = await connection.tooling.retrieve('PackageInstallRequest', requestId);

      if (!record) {
        throw new Error(`Could not retrieve PackageInstallRequest: ${requestId}`);
      }

      const status = (record as Record<string, unknown>).Status as string;

      this.logger?.info(`Installation status: ${status}`);
      this.sink?.versionProgress({status});

      if (status === 'SUCCESS' || status === 'ERROR') {
        return record as PackageInstallRequest;
      }

      // Wait 5 seconds before next poll
      // eslint-disable-next-line no-await-in-loop, no-promise-executor-return
      await new Promise(resolve => setTimeout(resolve, 5000));
      attempts++;
    }

    throw new Error(`Package installation timed out after ${maxAttempts * 5} seconds`);
  }

  /**
   * Handle a failed poll/status check by verifying server-side status.
   *
   * Returns normally only when the installation actually succeeded despite
   * the client-side failure. Throws in all other cases.
   */
  private async handleInstallFailure(
    error: unknown,
    requestId: string,
    packageName: string,
    targetOrg: string,
  ): Promise<void> {
    try {
      this.logger?.debug(`Install polling failed for ${packageName}, verifying server-side status (request ${requestId})...`);

      // Reconnect — the original connection may be dead
      const org = await Org.create({aliasOrUsername: targetOrg});
      const freshConnection = org.getConnection();
      const record = await freshConnection.tooling.retrieve('PackageInstallRequest', requestId);
      const status = (record as Record<string, unknown>).Status as string;

      if (status === 'SUCCESS') {
        this.logger?.info('Package installation succeeded server-side despite client error');
        return;
      }

      if (status === 'ERROR') {
        const installResult = record as PackageInstallRequest;
        const errors = installResult.Errors?.errors?.map(e => e.message).join('\n') || 'Unknown installation error';
        throw new Error(`Package installation failed:\n${errors}`, {cause: error});
      }

      // Still in progress (IN_PROGRESS / QUEUED)
      const msg = [
        `Package installation for ${packageName} was interrupted but is still in progress on the server.`,
        '',
        `  Request ID: ${requestId}`,
        `  Last Status: ${status}`,
        '',
        'Check status with:',
        `  sf package install report -i ${requestId} -o ${targetOrg}`,
      ].join('\n');

      this.logger?.error(msg);
      throw new Error(msg, {cause: error});
    } catch (verifyError) {
      // If this is our own rethrown error, propagate it
      if (verifyError instanceof Error && verifyError.cause === error) {
        throw verifyError;
      }

      // Verify query itself failed (connection still down) — throw original error
      this.logger?.debug(`Could not verify install status: ${verifyError instanceof Error ? verifyError.message : String(verifyError)}`);
      throw error;
    }
  }
}
