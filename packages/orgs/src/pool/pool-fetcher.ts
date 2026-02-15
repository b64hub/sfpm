import type {Logger} from '@b64/sfpm-core';

import {EventEmitter} from 'node:events';

import type OrgService from '../org/org-service.js';
import type {ScratchOrg} from '../org/scratch/types.js';

import {
  OrgError,
  type PoolFetchAllOptions,
  type PoolFetchOptions,
  type PoolOrgAuthenticator,
  type PoolOrgSource,
} from '../types.js';

// ============================================================================
// PoolFetcher Events
// ============================================================================

/**
 * Event map for PoolFetcher. Provides progress tracking during
 * fetch and claim operations.
 */
export interface PoolFetcherEvents {
  'pool:fetch:claimed': [payload: {tag: string; timestamp: Date; username: string}];
  'pool:fetch:complete': [payload: {count: number; tag: string; timestamp: Date}];
  'pool:fetch:skipped': [payload: {reason: string; timestamp: Date; username: string}];
  'pool:fetch:start': [payload: {available: number; tag: string; timestamp: Date}];
}

// ============================================================================
// PoolFetcher
// ============================================================================

/**
 * Fetches and claims scratch orgs from an existing pool.
 *
 * Migrated from the legacy `PoolFetchImpl`. Key differences:
 *
 * - **Composition over inheritance** — takes `PoolOrgSource`, `OrgService`,
 *   and `PoolOrgAuthenticator` via constructor instead of extending
 *   `PoolBaseImpl`.
 *
 * - **Prerequisite checks abstracted** — the legacy `PoolBaseImpl`
 *   embedded DevHub prerequisite validation. This is now a separate
 *   `PoolPrerequisiteChecker` interface, injected at the service layer.
 *
 * - **Authentication decoupled** — login, auth URL validation, and source
 *   tracking are handled by `PoolOrgAuthenticator`, keeping the fetcher
 *   SDK-free.
 *
 * Two fetch modes:
 * - `fetch()` — claim a single org using optimistic concurrency
 * - `fetchAll()` — return multiple available orgs without claiming
 *
 * @example
 * ```ts
 * const fetcher = new PoolFetcher(orgSource, orgService, authenticator, logger);
 * fetcher.on('pool:fetch:claimed', (p) => console.log(`Claimed ${p.username}`));
 *
 * const org = await fetcher.fetch({ tag: 'dev-pool' });
 * console.log(`Got org: ${org.username}`);
 * ```
 */
export default class PoolFetcher extends EventEmitter<PoolFetcherEvents> {
  constructor(
    private readonly orgSource: PoolOrgSource,
    private readonly orgService: OrgService,
    private readonly authenticator?: PoolOrgAuthenticator,
    private readonly logger?: Logger,
  ) {
    super();
  }

  // --------------------------------------------------------------------------
  // Public API
  // --------------------------------------------------------------------------

  /**
   * Fetch a single scratch org from the pool.
   *
   * Uses optimistic concurrency to claim an available org: iterates
   * through candidates and attempts to mark each as `'Allocate'`.
   * The first successful claim wins. If the org has an auth URL,
   * it is authenticated locally.
   *
   * @throws {OrgError} When no orgs are available or none could be claimed
   */
  public async fetch(options: PoolFetchOptions): Promise<ScratchOrg> {
    const available = await this.getFilteredCandidates(options);

    this.emit('pool:fetch:start', {
      available: available.length,
      tag: options.tag,
      timestamp: new Date(),
    });

    // Try to claim an org (optimistic concurrency — sequential by design)
    for (const org of available) {
      // eslint-disable-next-line no-await-in-loop -- sequential claims: we want exactly one org
      const claimed = await this.orgSource.claimOrg(org.recordId!);

      if (claimed) {
        org.status = 'Assigned';

        this.emit('pool:fetch:claimed', {
          tag: options.tag,
          timestamp: new Date(),
          username: org.username!,
        });

        this.logger?.info(`Claimed org ${org.username} from pool "${options.tag}"`);

        // eslint-disable-next-line no-await-in-loop -- post-claim runs only once (we return immediately after)
        await this.handlePostClaim(org, options);

        this.emit('pool:fetch:complete', {
          count: 1,
          tag: options.tag,
          timestamp: new Date(),
        });

        return org;
      }

      this.emit('pool:fetch:skipped', {
        reason: 'Claim failed (already taken by another consumer)',
        timestamp: new Date(),
        username: org.username!,
      });

      this.logger?.trace(`Org ${org.username} claim failed, trying next...`);
    }

    throw new OrgError('fetch', `No scratch org could be claimed from pool "${options.tag}"`, {
      context: {candidateCount: available.length, tag: options.tag},
    });
  }

  /**
   * Fetch multiple available scratch orgs from the pool.
   *
   * Unlike `fetch()`, this does NOT claim individual orgs. The caller
   * is responsible for updating allocation status as needed (e.g., when
   * transferring orgs from a snapshot pool to a new pool).
   *
   * Orgs that fail authentication are silently filtered out.
   *
   * @throws {OrgError} When no orgs are available
   */
  public async fetchAll(options: PoolFetchAllOptions): Promise<ScratchOrg[]> {
    let candidates = await this.getFilteredCandidates(options);

    this.emit('pool:fetch:start', {
      available: candidates.length,
      tag: options.tag,
      timestamp: new Date(),
    });

    // Apply limit
    if (options.limit && options.limit < candidates.length) {
      candidates = candidates.slice(0, options.limit);
    }

    // Assign aliases
    const orgs: ScratchOrg[] = candidates.map((org, i) => ({
      ...org,
      alias: `SO${i + 1}`,
      status: 'Available' as const,
    }));

    // Authenticate if authenticator is available and not sending to user
    const validOrgs = this.authenticator && !options.sendToUser
      ? await this.authenticateOrgs(orgs)
      : orgs;

    this.emit('pool:fetch:complete', {
      count: validOrgs.length,
      tag: options.tag,
      timestamp: new Date(),
    });

    return validOrgs;
  }

  // --------------------------------------------------------------------------
  // Private — Filtering
  // --------------------------------------------------------------------------

  /**
   * Authenticate multiple orgs in parallel, filtering out failures.
   */
  private async authenticateOrgs(orgs: ScratchOrg[]): Promise<ScratchOrg[]> {
    const results = await Promise.all(orgs.map(org => this.authenticateSingleOrg(org)));

    return results.filter((org): org is ScratchOrg => org !== null);
  }

  /**
   * Attempt to authenticate a single org. Returns null on failure.
   */
  private async authenticateSingleOrg(org: ScratchOrg): Promise<null | ScratchOrg> {
    try {
      const loggedIn = await this.authenticator!.login(org);

      if (!loggedIn) {
        this.logger?.warn(`Unable to authenticate to ${org.username}`);
        return null;
      }

      return org;
    } catch (error) {
      this.logger?.warn(`Authentication failed for ${org.username}: ${error instanceof Error ? error.message : error}`);
      return null;
    }
  }

  /**
   * Query available orgs and filter by auth validity if required.
   */
  private async getFilteredCandidates(options: PoolFetchOptions): Promise<ScratchOrg[]> {
    const available = await this.orgSource.getAvailableByTag(options.tag, options.myPool);

    if (available.length === 0) {
      throw new OrgError('fetch', `No scratch orgs available for pool "${options.tag}"`, {
        context: {tag: options.tag},
      });
    }

    this.logger?.info(`Pool "${options.tag}" has ${available.length} available org(s)`);

    // Filter by auth validity if required
    if (options.requireValidAuth && this.authenticator) {
      const filtered = available.filter(org => this.authenticator!.hasValidAuth(org));

      if (filtered.length === 0) {
        throw new OrgError('fetch', `No scratch orgs with valid auth credentials in pool "${options.tag}"`, {
          context: {availableCount: available.length, tag: options.tag},
        });
      }

      this.logger?.debug(`${filtered.length} of ${available.length} org(s) have valid auth credentials`);
      return filtered;
    }

    return available;
  }

  // --------------------------------------------------------------------------
  // Private — Post-claim actions
  // --------------------------------------------------------------------------

  /**
   * Handle post-claim actions: send email, login, source tracking.
   */
  private async handlePostClaim(org: ScratchOrg, options: PoolFetchOptions): Promise<void> {
    if (options.sendToUser) {
      await this.orgService.shareScratchOrg(org, {emailAddress: options.sendToUser});
      return;
    }

    if (!this.authenticator) {
      return;
    }

    const loggedIn = await this.authenticator.login(org);

    if (!loggedIn) {
      this.logger?.warn(`Unable to authenticate to claimed org ${org.username}`);
      return;
    }

    if (options.enableSourceTracking && this.authenticator.enableSourceTracking) {
      try {
        await this.authenticator.enableSourceTracking(org);
      } catch (error) {
        this.logger?.trace(`Source tracking setup skipped: ${error instanceof Error ? error.message : error}`);
      }
    }
  }
}
