import type {Logger} from '@b64/sfpm-core';

import {EventEmitter} from 'node:events';

import type {ScratchOrg} from './scratch/types.js';

import {
  type CreateScratchOrgOptions,
  DEFAULT_SCRATCH_ORG,
  type HubOrgConnection,
  OrgError,
  type OrgServiceEvents,
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
    private readonly hubOrg: HubOrgConnection,
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
