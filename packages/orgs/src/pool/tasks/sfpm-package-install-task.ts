import type {Connection} from '@salesforce/core';

import {
  escapeSOQL,
  type Logger,
  PackageService,
  soql,
} from '@b64hub/sfpm-core';
import {Org} from '@salesforce/core';

import type {PoolOrg} from '../../org/pool-org.js';
import type {PoolOrgTask, PoolOrgTaskResult} from '../types.js';

/**
 * The unscoped Package2 name for the SFPM artifact custom setting package.
 */
const SFPM_PACKAGE_NAME = 'sfpm-artifact';

/**
 * Permission set (shipped in the `sfpm-artifact` package) that grants access
 * to the `Sfpm_Artifact__c` custom setting. Without it, the running user
 * can't read/write artifact tracking records even though the object exists.
 */
const MANAGE_ARTIFACTS_PERMSET = 'Manage_Artifacts';

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
 * 4. If not, install it via {@link PackageService.installPackage}.
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
      await this.assignManageArtifactsPermSet(connection, username, logger);
      return {success: true};
    }

    // 4. Install via PackageService — wraps PackageInstallRequest creation
    // and polling (create/status/timeout) so we don't hand-roll it here.
    logger.info(`Installing ${SFPM_PACKAGE_NAME} (${subscriberVersionId}) to ${username}...`);

    try {
      await packageService.installPackage(subscriberVersionId, {
        apexCompile: 'package',
        securityType: 'AllUsers',
        wait: 10,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {error: `Package installation failed: ${message}`, success: false};
    }

    logger.info(`${SFPM_PACKAGE_NAME} installed successfully`);
    await this.assignManageArtifactsPermSet(connection, username, logger);
    return {success: true};
  }

  /**
   * Assign the `Manage_Artifacts` permission set to the running user, so
   * they can actually access `Sfpm_Artifact__c` (object exists once the
   * package is installed, but access still requires the permission set).
   *
   * Idempotent — checks for an existing assignment first. Degrades
   * gracefully (logs a warning, doesn't fail the task) if the permission
   * set isn't found or the assignment otherwise fails.
   */
  private async assignManageArtifactsPermSet(connection: Connection, username: string, logger: Logger): Promise<void> {
    try {
      const userResult = await connection.query<{Id: string}>(soql`SELECT Id FROM User WHERE Username = '${escapeSOQL(username)}' LIMIT 1`);
      const userId = userResult.records[0]?.Id;
      if (!userId) {
        logger.warn(`Could not resolve user Id for ${username} — skipping ${MANAGE_ARTIFACTS_PERMSET} assignment`);
        return;
      }

      const permSetResult = await connection.query<{Id: string}>(soql`SELECT Id FROM PermissionSet WHERE Name = '${escapeSOQL(MANAGE_ARTIFACTS_PERMSET)}' LIMIT 1`);
      const permSetId = permSetResult.records[0]?.Id;
      if (!permSetId) {
        logger.warn(`Permission set "${MANAGE_ARTIFACTS_PERMSET}" not found in org — skipping assignment`);
        return;
      }

      const existing = await connection.query<{Id: string}>(soql`SELECT Id FROM PermissionSetAssignment WHERE AssigneeId = '${userId}' AND PermissionSetId = '${permSetId}' LIMIT 1`);
      if (existing.records.length > 0) {
        logger.debug(`${MANAGE_ARTIFACTS_PERMSET} already assigned to ${username}`);
        return;
      }

      await connection.sobject('PermissionSetAssignment').create({AssigneeId: userId, PermissionSetId: permSetId});
      logger.info(`Assigned "${MANAGE_ARTIFACTS_PERMSET}" permission set to ${username}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.warn(`Failed to assign "${MANAGE_ARTIFACTS_PERMSET}" permission set to ${username}: ${message}`);
    }
  }

  /**
   * Query the DevHub for the latest released version of the
   * `sfpm-artifact` Package2 and return its subscriber version ID.
   */
  private async resolveLatestVersion(logger: Logger): Promise<string | undefined> {
    const packageService = new PackageService(this.devhub, logger);

    // Find the Package2 by name
    const allPackages = await packageService.listPackages();
    const sfpmPackage = allPackages.find(p => p.Name === SFPM_PACKAGE_NAME);

    if (!sfpmPackage) {
      logger.warn(`Package "${SFPM_PACKAGE_NAME}" not found on DevHub`);
      return undefined;
    }

    // Get the latest released version
    const versions = await packageService.listPackageVersions({
      isReleased: true,
      packages: [sfpmPackage.Id],
    });

    if (versions.length === 0) {
      logger.warn(`No released versions found for "${SFPM_PACKAGE_NAME}"`);
      return undefined;
    }

    // Already sorted descending by semver — first is latest
    return versions[0].SubscriberPackageVersionId;
  }
}
