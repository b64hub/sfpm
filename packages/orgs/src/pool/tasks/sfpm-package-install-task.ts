import {
  type Logger,
  PackageService,
} from '@b64hub/sfpm-core';
import {Org} from '@salesforce/core';

import type {PoolOrg} from '../../org/pool-org.js';
import type {PoolOrgTask, PoolOrgTaskResult} from '../types.js';

/**
 * The unscoped Package2 name for the SFPM artifact custom setting package.
 */
const SFPM_PACKAGE_NAME = 'sfpm-artifact';

/**
 * Options for the {@link SfpmPackageInstallTask}.
 */
export interface SfpmPackageInstallTaskOptions {
  /** Whether to continue provisioning if the install fails. Defaults to false. */
  continueOnError?: boolean;
  /** The resolved DevHub `Org` instance, used to query Package2Version. */
  devhub: Org;
}

/**
 * Pool task that installs the `sfpm-artifact` unlocked package into a
 * scratch org before other deployment tasks run.
 *
 * The `sfpm-artifact` package contains the `Sfpm_Artifact__c` custom
 * setting used for artifact tracking. Without it, source deployments
 * that attempt to update artifact records will fail.
 *
 * **Flow:**
 * 1. Query the DevHub for the latest released `Package2Version` of
 *    the `sfpm-artifact` package.
 * 2. Connect to the scratch org.
 * 3. Check whether that version is already installed.
 * 4. If not, create a `PackageInstallRequest` via the Tooling API
 *    and poll until complete.
 *
 * This task is only relevant for scratch orgs. Sandboxes inherit
 * installed packages from their source org.
 */
export class SfpmPackageInstallTask implements PoolOrgTask {
  public readonly continueOnError: boolean;
  public readonly name = 'install-sfpm-package';
  private readonly devhub: Org;

  constructor(options: SfpmPackageInstallTaskOptions) {
    this.devhub = options.devhub;
    this.continueOnError = options.continueOnError ?? false;
  }

  async execute(org: PoolOrg, logger: Logger): Promise<PoolOrgTaskResult> {
    const {username} = org.auth;

    if (!username) {
      return {error: 'Org has no username', success: false};
    }

    // 1. Resolve the latest released subscriber version from the DevHub
    const subscriberVersionId = await this.resolveLatestVersion(logger);
    if (!subscriberVersionId) {
      return {
        error: `Package "${SFPM_PACKAGE_NAME}" not found on the DevHub — run "sfpm bootstrap" first`,
        success: false,
      };
    }

    logger.info(`Resolved ${SFPM_PACKAGE_NAME} subscriber version: ${subscriberVersionId}`);

    // 2. Connect to the scratch org
    const scratchOrg = await Org.create({aliasOrUsername: username});
    const connection = scratchOrg.getConnection();

    // 3. Check if already installed
    const packageService = new PackageService(scratchOrg, logger);
    const alreadyInstalled = await packageService.isSubscriberVersionInstalled(subscriberVersionId);

    if (alreadyInstalled) {
      logger.info(`${SFPM_PACKAGE_NAME} (${subscriberVersionId}) already installed — skipping`);
      return {success: true};
    }

    // 4. Install via PackageInstallRequest
    logger.info(`Installing ${SFPM_PACKAGE_NAME} (${subscriberVersionId}) to ${username}...`);

    const installRequest = {
      ApexCompileType: 'package',
      NameConflictResolution: 'Block',
      Password: '',
      SecurityType: 'Full',
      SubscriberPackageVersionKey: subscriberVersionId,
    };

    const result = await connection.tooling.create('PackageInstallRequest', installRequest);

    if (!result.success || !result.id) {
      return {
        error: `Failed to create install request: ${JSON.stringify(result.errors ?? [])}`,
        success: false,
      };
    }

    const requestId = result.id as string;
    logger.debug(`PackageInstallRequest created: ${requestId}`);

    // Poll for completion (max ~10 minutes)
    const maxAttempts = 120;
    let attempts = 0;

    while (attempts < maxAttempts) {
      // eslint-disable-next-line no-await-in-loop
      const record = await connection.tooling.retrieve('PackageInstallRequest', requestId);

      if (!record) {
        return {error: `Could not retrieve PackageInstallRequest: ${requestId}`, success: false};
      }

      const status = (record as Record<string, unknown>).Status as string;

      if (status === 'SUCCESS') {
        logger.info(`${SFPM_PACKAGE_NAME} installed successfully`);
        return {success: true};
      }

      if (status === 'ERROR') {
        const errors = (record as any).Errors?.errors
        ?.map((e: {message: string}) => e.message)
        .join('\n') || 'Unknown error';
        return {error: `Package installation failed:\n${errors}`, success: false};
      }

      // eslint-disable-next-line no-await-in-loop, no-promise-executor-return
      await new Promise(resolve => setTimeout(resolve, 5000));
      attempts++;
    }

    return {error: `Package installation timed out after ${maxAttempts * 5} seconds`, success: false};
  }

  /**
   * Query the DevHub for the latest released version of the
   * `sfpm-artifact` Package2 and return its subscriber version ID.
   */
  private async resolveLatestVersion(logger: Logger): Promise<string | undefined> {
    const packageService = new PackageService(this.devhub, logger);

    // Find the Package2 by name
    const allPackages = await packageService.listAllPackages();
    const sfpmPackage = allPackages.find(p => p.Name === SFPM_PACKAGE_NAME);

    if (!sfpmPackage) {
      logger.warn(`Package "${SFPM_PACKAGE_NAME}" not found on DevHub`);
      return undefined;
    }

    // Get the latest released version
    const versions = await packageService.getPackage2VersionById(
      sfpmPackage.Id,
      undefined,
      false,
      true,
    );

    if (versions.length === 0) {
      logger.warn(`No released versions found for "${SFPM_PACKAGE_NAME}"`);
      return undefined;
    }

    // Already sorted descending by semver — first is latest
    return versions[0].SubscriberPackageVersionId;
  }
}
