import type {Logger} from '@b64/sfpm-core';

import {EventEmitter} from 'node:events';

import type {OrgUsage, PoolOrgInspector} from './org-provider.js';
import type {PoolOrg} from './pool-org.js';

import {
  type AllocationStatus,
  type DevHub,
  OrgError,
  type OrgServiceEvents,
  type ShareOrgOptions,
} from './types.js';

// ============================================================================
// OrgService
// ============================================================================

/**
 * Service for org-type-agnostic admin operations.
 *
 * Wraps a {@link PoolOrgInspector} (for queries and record updates)
 * and an optional {@link DevHub} (for email sharing). All methods
 * work identically for scratch orgs and sandboxes — the provider
 * handles the SObject differences.
 *
 * Provisioning and deletion are handled by `PoolManager` + `OrgProvider`;
 * `OrgService` covers the remaining admin surface: orphan discovery,
 * usage reporting, credential sharing, and status updates.
 *
 * @example
 * ```ts
 * const orgService = new OrgService(provider, hub, logger);
 * orgService.on('org:share:complete', (p) => {
 *   console.log(`Shared ${p.username} with ${p.emailAddress}`);
 * });
 *
 * const orphans = await orgService.getOrphanedOrgs();
 * await orgService.shareOrg(org, { emailAddress: 'user@example.com' });
 * ```
 */
export default class OrgService extends EventEmitter<OrgServiceEvents> {
  constructor(
    private readonly inspector: PoolOrgInspector,
    private readonly hub?: DevHub,
    private readonly logger?: Logger,
  ) {
    super();
  }

  // --------------------------------------------------------------------------
  // Public — Queries
  // --------------------------------------------------------------------------

  /**
   * Find active orgs that have no pool tag.
   *
   * Returns orgs that were created outside the pool lifecycle or whose
   * pool tag was cleared. Useful for cleanup operations.
   *
   * @throws {OrgError} When the query fails
   */
  public async getOrphanedOrgs(): Promise<PoolOrg[]> {
    this.logger?.debug('Querying orphaned orgs...');

    try {
      const orgs = await this.inspector.getOrphanedOrgs();
      this.logger?.info(`Found ${orgs.length} orphaned org(s)`);
      return orgs;
    } catch (error) {
      throw new OrgError('fetch', 'Failed to query orphaned orgs', {
        cause: error instanceof Error ? error : new Error(String(error)),
      });
    }
  }

  /**
   * Get org usage counts grouped by user email.
   *
   * Returns an array of `{ email, count }` entries ordered by count
   * descending. Useful for reporting and capacity planning.
   *
   * @throws {OrgError} When the query fails
   */
  public async getOrgUsageByUser(): Promise<OrgUsage[]> {
    this.logger?.debug('Querying org usage by user...');

    try {
      const usage = await this.inspector.getOrgUsageByUser();
      this.logger?.info(`Found usage data for ${usage.length} user(s)`);
      return usage;
    } catch (error) {
      throw new OrgError('fetch', 'Failed to query org usage by user', {
        cause: error instanceof Error ? error : new Error(String(error)),
      });
    }
  }

  // --------------------------------------------------------------------------
  // Public — Sharing
  // --------------------------------------------------------------------------

  /**
   * Share org credentials with a user via email.
   *
   * Requires a `HubService` to be provided at construction time.
   *
   * @throws {OrgError} When the hub is missing or the email fails to send
   */
  public async shareOrg(org: PoolOrg, options: ShareOrgOptions): Promise<void> {
    if (!this.hub) {
      throw new OrgError('share', 'Hub service is required to share org credentials via email');
    }

    const {emailAddress} = options;
    const hubUsername = this.hub.getUsername();

    const body = [
      `${hubUsername} has fetched a new org from the pool!`,
      '',
      'All post-provisioning scripts have been successfully completed in this org!',
      '',
      `Login URL: ${org.auth.loginUrl}`,
      `Username: ${org.auth.username}`,
      `Password: ${org.auth.password}`,
      '',
      `Use: sf org login web --instance-url ${org.auth.loginUrl} --alias <alias>`,
    ].join('\n');

    try {
      await this.hub.sendEmail({
        body,
        subject: `${hubUsername} created you a new Salesforce org`,
        to: emailAddress,
      });

      this.logger?.info(`Email sent to ${emailAddress} for ${org.auth.username}`);

      this.emit('org:share:complete', {
        emailAddress,
        timestamp: new Date(),
        username: org.auth.username,
      });
    } catch (error) {
      throw new OrgError('share', `Failed to send org details to ${emailAddress}`, {
        cause: error instanceof Error ? error : new Error(String(error)),
        orgIdentifier: org.auth.username,
      });
    }
  }

  // --------------------------------------------------------------------------
  // Public — Status updates
  // --------------------------------------------------------------------------

  /**
   * Update the allocation status of a pool org.
   *
   * Sets the `Allocation_Status__c` field on the org's info record
   * (ScratchOrgInfo or SandboxInfo, depending on the provider).
   *
   * @param recordId - The org info record ID (e.g., from `PoolOrg.recordId`)
   * @param status - The new allocation status to set
   * @returns `true` if the update succeeded
   * @throws {OrgError} When the update fails
   */
  public async updateOrgStatus(recordId: string, status: AllocationStatus): Promise<boolean> {
    this.logger?.debug(`Updating status for record ${recordId} to "${status}"`);

    try {
      const result = await this.inspector.updateOrgInfo({
        Allocation_Status__c: status, // eslint-disable-line camelcase -- Salesforce custom field name
        Id: recordId,
      });

      this.emit('org:status:complete', {
        recordId,
        status,
        timestamp: new Date(),
      });

      this.logger?.info(`Status updated to "${status}" for record ${recordId}`);
      return result;
    } catch (error) {
      throw new OrgError('update', `Failed to update org status to "${status}"`, {
        cause: error instanceof Error ? error : new Error(String(error)),
        context: {recordId, status},
      });
    }
  }
}
