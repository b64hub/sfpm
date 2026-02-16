import type {Logger} from '@b64/sfpm-core';

import {EventEmitter} from 'node:events';

import type {ScratchOrg} from './scratch/types.js';

import {
  type AllocationStatus,
  type CreateScratchOrgOptions,
  DEFAULT_SCRATCH_ORG,
  type DevHub,
  OrgError,
  type OrgServiceEvents,
  type ScratchOrgUsage,
  type ShareScratchOrgOptions,
} from '../types.js';

// ============================================================================
// OrgService
// ============================================================================

/**
 * Service for managing Salesforce orgs (scratch, sandbox, etc.).
 *
 * Migrated from the legacy ScratchOrgOperator. Follows SFPM patterns:
 * - Dependency injection for hub connection and logger
 * - EventEmitter for progress tracking
 * - Structured OrgError for failures
 * - Interface-based abstraction over Salesforce SDK
 *
 * @example
 * ```ts
 * const orgService = new OrgService(hubConnection, logger);
 * orgService.on('scratch:create:complete', (payload) => {
 *   console.log(`Created ${payload.username} in ${payload.elapsedMs}ms`);
 * });
 *
 * const scratchOrg = await orgService.createScratchOrg({
 *   alias: 'my-org',
 *   definitionFile: 'config/project-scratch-def.json',
 *   expiryDays: 7,
 * });
 * ```
 */
export default class OrgService extends EventEmitter<OrgServiceEvents> {
  constructor(
    private readonly hubOrg: DevHub,
    private readonly logger?: Logger,
  ) {
    super();
  }

  // --------------------------------------------------------------------------
  // Public — Scratch Org lifecycle
  // --------------------------------------------------------------------------

  /**
   * Create a new scratch org against the DevHub.
   *
   * Handles the full provisioning flow: create the org, generate a password,
   * and return a populated ScratchOrg object. Scratch orgs inherit the
   * DevHub's JWT credentials automatically via `parentUsername`.
   *
   * @throws {OrgError} When creation or password generation fails
   */
  public async createScratchOrg(options: CreateScratchOrgOptions): Promise<ScratchOrg> {
    const {
      alias,
      definitionFile,
      expiryDays = DEFAULT_SCRATCH_ORG.expiryDays,
      noAncestors = DEFAULT_SCRATCH_ORG.noAncestors,
      waitMinutes = DEFAULT_SCRATCH_ORG.waitMinutes,
    } = options;

    this.logger?.trace(`createScratchOrg params: alias=${alias} def=${definitionFile} expiry=${expiryDays}`);

    this.emit('scratch:create:start', {
      alias,
      definitionFile,
      timestamp: new Date(),
    });

    const startTime = Date.now();
    this.logger?.info(`Requesting scratch org "${alias}"...`);

    try {
      // 1. Request the scratch org from the DevHub
      const result = await this.hubOrg.createScratchOrg({
        definitionFile,
        durationDays: expiryDays,
        noAncestors,
        noNamespace: false,
        retries: DEFAULT_SCRATCH_ORG.maxRetries,
        waitMinutes,
      });

      this.logger?.trace(`Scratch org create result: ${JSON.stringify(result)}`);

      // 2. Set the local alias
      await this.hubOrg.setAlias(result.username, alias);

      // 3. Build the domain object
      const scratchOrg: ScratchOrg = {
        alias,
        elapsedTime: Date.now() - startTime,
        loginURL: result.loginUrl,
        orgId: result.orgId,
        username: result.username,
      };

      // 4. Generate password
      scratchOrg.password = await this.setPassword(scratchOrg);

      const elapsedMs = Date.now() - startTime;
      scratchOrg.elapsedTime = elapsedMs;

      this.logger?.info(`Scratch org "${alias}" created successfully in ${formatElapsed(elapsedMs)}`);

      this.emit('scratch:create:complete', {
        alias,
        elapsedMs,
        orgId: scratchOrg.orgId!,
        timestamp: new Date(),
        username: scratchOrg.username!,
      });

      return scratchOrg;
    } catch (error) {
      // Don't re-wrap OrgError — just re-throw
      if (error instanceof OrgError) {
        this.emitCreateError(alias, error);
        throw error;
      }

      const wrapped = new OrgError('create', 'Scratch org creation failed', {
        cause: error instanceof Error ? error : new Error(String(error)),
        orgIdentifier: alias,
      });
      this.emitCreateError(alias, wrapped);
      throw wrapped;
    }
  }

  // --------------------------------------------------------------------------
  // Public — Scratch Org queries
  // --------------------------------------------------------------------------

  /**
   * Delete scratch orgs by their ActiveScratchOrg record IDs.
   *
   * @throws {OrgError} When deletion fails after retries
   */
  public async deleteScratchOrgs(scratchOrgIds: string[]): Promise<void> {
    this.emit('scratch:delete:start', {
      orgIds: scratchOrgIds,
      timestamp: new Date(),
    });

    try {
      await this.hubOrg.deleteActiveScratchOrgs(scratchOrgIds);

      this.emit('scratch:delete:complete', {
        orgIds: scratchOrgIds,
        timestamp: new Date(),
      });

      this.logger?.info(`Deleted ${scratchOrgIds.length} scratch org(s)`);
    } catch (error) {
      throw new OrgError('delete', 'Failed to delete scratch orgs', {
        cause: error instanceof Error ? error : new Error(String(error)),
        context: {orgIds: scratchOrgIds},
      });
    }
  }

  /**
   * Find active scratch orgs that have no pool tag.
   *
   * Returns orgs that were created outside the pool lifecycle or whose
   * pool tag was cleared. Useful for cleanup operations.
   *
   * @throws {OrgError} When the query fails
   */
  public async getOrphanedScratchOrgs(): Promise<ScratchOrg[]> {
    this.logger?.debug('Querying orphaned scratch orgs...');

    try {
      const orgs = await this.hubOrg.getOrphanedScratchOrgs();
      this.logger?.info(`Found ${orgs.length} orphaned scratch org(s)`);
      return orgs;
    } catch (error) {
      throw new OrgError('fetch', 'Failed to query orphaned scratch orgs', {
        cause: error instanceof Error ? error : new Error(String(error)),
      });
    }
  }

  // --------------------------------------------------------------------------
  // Public — Scratch Org mutations
  // --------------------------------------------------------------------------

  /**
   * Get scratch org usage counts grouped by user email.
   *
   * Returns an array of `{ email, count }` entries ordered by count
   * descending. Useful for reporting and capacity planning.
   *
   * @throws {OrgError} When the query fails
   */
  public async getScratchOrgUsageByUser(): Promise<ScratchOrgUsage[]> {
    this.logger?.debug('Querying scratch org usage by user...');

    try {
      const usage = await this.hubOrg.getScratchOrgUsageByUser();
      this.logger?.info(`Found usage data for ${usage.length} user(s)`);
      return usage;
    } catch (error) {
      throw new OrgError('fetch', 'Failed to query scratch org usage by user', {
        cause: error instanceof Error ? error : new Error(String(error)),
      });
    }
  }

  /**
   * Share scratch org credentials with a user via email.
   *
   * @throws {OrgError} When the email fails to send
   */
  public async shareScratchOrg(scratchOrg: ScratchOrg, options: ShareScratchOrgOptions): Promise<void> {
    const {emailAddress} = options;
    const hubOrgUsername = this.hubOrg.getUsername();

    const body = [
      `${hubOrgUsername} has fetched a new scratch org from the Scratch Org Pool!`,
      '',
      'All the post scratch org scripts have been successfully completed in this org!',
      '',
      `Login URL: ${scratchOrg.loginURL}`,
      `Username: ${scratchOrg.username}`,
      `Password: ${scratchOrg.password}`,
      '',
      `Use: sf org login web --instance-url ${scratchOrg.loginURL} --alias <alias>`,
    ].join('\n');

    try {
      await this.hubOrg.sendEmail({
        body,
        subject: `${hubOrgUsername} created you a new Salesforce org`,
        to: emailAddress,
      });

      this.logger?.info(`Email sent to ${emailAddress} for ${scratchOrg.username}`);

      this.emit('scratch:share:complete', {
        emailAddress,
        timestamp: new Date(),
        username: scratchOrg.username!,
      });
    } catch (error) {
      throw new OrgError('share', `Failed to send scratch org details to ${emailAddress}`, {
        cause: error instanceof Error ? error : new Error(String(error)),
        orgIdentifier: scratchOrg.username,
      });
    }
  }

  /**
   * Update the allocation status of a scratch org.
   *
   * Resolves the ScratchOrgInfo record from the DevHub by username,
   * then sets its `Allocation_status__c` field.
   *
   * @param username - The scratch org's SignupUsername
   * @param status - The new allocation status to set
   * @returns `true` if the update succeeded
   * @throws {OrgError} When the ScratchOrgInfo record cannot be found or the update fails
   */
  public async updateScratchOrgStatus(username: string, status: AllocationStatus): Promise<boolean> {
    this.logger?.debug(`Updating status for ${username} to "${status}"`);

    const scratchOrgInfoId = await this.hubOrg.getScratchOrgInfoByUsername(username);

    if (!scratchOrgInfoId) {
      throw new OrgError('update', `ScratchOrgInfo record not found for username: ${username}`, {
        context: {status},
        orgIdentifier: username,
      });
    }

    try {
      const result = await this.hubOrg.updateScratchOrgInfo({
        Allocation_status__c: status, // eslint-disable-line camelcase -- Salesforce custom field name
        Id: scratchOrgInfoId,
      });

      this.emit('scratch:status:complete', {
        status,
        timestamp: new Date(),
        username,
      });

      this.logger?.info(`Status for ${username} updated to "${status}"`);
      return result;
    } catch (error) {
      throw new OrgError('update', `Failed to update scratch org status to "${status}"`, {
        cause: error instanceof Error ? error : new Error(String(error)),
        context: {scratchOrgInfoId, status},
        orgIdentifier: username,
      });
    }
  }

  // --------------------------------------------------------------------------
  // Private helpers
  // --------------------------------------------------------------------------

  private emitCreateError(alias: string, error: Error): void {
    this.emit('scratch:create:error', {
      alias,
      error: error.message,
      timestamp: new Date(),
    });
  }

  private async setPassword(scratchOrg: ScratchOrg): Promise<string> {
    const result = await this.hubOrg.generatePassword(scratchOrg.username!);

    if (!result.password) {
      throw new OrgError('password', 'Unable to generate password for scratch org', {
        orgIdentifier: scratchOrg.alias,
      });
    }

    this.logger?.debug(`Password set for "${scratchOrg.alias}"`);
    return result.password;
  }
}

// ============================================================================
// Utilities
// ============================================================================

/** Format milliseconds into a human-readable duration string. */
function formatElapsed(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);

  if (minutes > 0) {
    const remainingSeconds = seconds % 60;
    return `${minutes}m ${remainingSeconds}s`;
  }

  return `${seconds}s`;
}
