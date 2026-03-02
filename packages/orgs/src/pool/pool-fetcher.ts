import type {Logger} from '@b64/sfpm-core';

import {EventEmitter} from 'node:events';

import type {OrgProvider} from '../org/org-provider.js';
import type {PoolOrg} from '../org/pool-org.js';
import type {PoolFetchOptions, PostClaimAction} from './types.js';

import {OrgError} from '../org/types.js';

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

/**
 * Fetches and claims orgs from an existing pool.
 *
 * - **Composition over inheritance** — takes `OrgProvider` via constructor
 *
 * - **Post-claim pipeline** — authentication, source tracking, email sharing,
 *   and any other post-claim behavior is composed via `postClaimActions` on
 *   `PoolFetchOptions`. The fetcher itself is SDK-free and auth-agnostic.
 *
 * Two fetch modes:
 * - `fetch()` — claim a single org using optimistic concurrency
 * - `fetchAll()` — return multiple available orgs without claiming
 *
 * @example
 * ```ts
 * const fetcher = new PoolFetcher(orgSource, logger);
 * fetcher.on('pool:fetch:claimed', (p) => console.log(`Claimed ${p.username}`));
 *
 * const org = await fetcher.fetch({
 *   tag: 'dev-pool',
 *   postClaimActions: [
 *     (org) => authenticator.login(org),
 *     (org) => authenticator.enableSourceTracking(org),
 *   ],
 * });
 * console.log(`Got org: ${org.auth.username}`);
 * ```
 */
export default class PoolFetcher extends EventEmitter<PoolFetcherEvents> {
  constructor(
    private readonly provider: OrgProvider,
    private readonly logger?: Logger,
  ) {
    super();
  }

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
  public async fetch(options: PoolFetchOptions): Promise<PoolOrg> {
    const available = await this.provider.getAvailableByTag(options.tag, options.myPool);

    if (available.length === 0) {
      throw new OrgError('fetch', `No orgs available for pool "${options.tag}"`, {
        context: {tag: options.tag},
      });
    }

    this.logger?.info(`Pool "${options.tag}" has ${available.length} candidate(s)`);

    this.emit('pool:fetch:start', {
      available: available.length,
      tag: options.tag,
      timestamp: new Date(),
    });

    // Try to claim an org (optimistic concurrency — sequential by design)
    for (const org of available) {
      // eslint-disable-next-line no-await-in-loop -- sequential claims: we want exactly one org
      const claimed = await this.provider.claimOrg(org.recordId!);

      if (claimed) {
        if (org.pool) {
          org.pool.status = 'Assigned';
        }

        this.emit('pool:fetch:claimed', {
          tag: options.tag,
          timestamp: new Date(),
          username: org.auth.username!,
        });

        this.logger?.info(`Claimed org ${org.auth.username} from pool "${options.tag}"`);

        // eslint-disable-next-line no-await-in-loop -- post-claim runs only once (we return immediately after)
        await this.handlePostClaims([org], options.postClaimActions ?? []);

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
        username: org.auth.username!,
      });

      this.logger?.trace(`Org ${org.auth.username} claim failed, trying next...`);
    }

    throw new OrgError('fetch', `No org could be claimed from pool "${options.tag}"`, {
      context: {candidateCount: available.length, tag: options.tag},
    });
  }

  /**
   * Fetch multiple available orgs from the pool.
   *
   * Unlike `fetch()`, this does NOT claim individual orgs. The caller
   * is responsible for updating allocation status as needed (e.g., when
   * transferring orgs from a snapshot pool to a new pool).
   *
   * Post-claim actions run per-org in parallel. Orgs where any action
   * throws are silently filtered out.
   *
   * @throws {OrgError} When no orgs are available
   */
  public async fetchAll(options: PoolFetchOptions): Promise<PoolOrg[]> {
    let candidates = await this.provider.getAvailableByTag(options.tag, options.myPool);

    if (candidates.length === 0) {
      throw new OrgError('fetch', `No orgs available for pool "${options.tag}"`, {
        context: {tag: options.tag},
      });
    }

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
    const orgs: PoolOrg[] = candidates.map((org, i) => ({
      ...org,
      auth: {...org.auth, alias: `SO${i + 1}`},
      pool: {status: 'Available', tag: org.pool?.tag ?? options.tag, timestamp: org.pool?.timestamp ?? Date.now()},
    }));

    const validOrgs = await this.handlePostClaims(orgs, options.postClaimActions ?? []);

    this.emit('pool:fetch:complete', {
      count: validOrgs.length,
      tag: options.tag,
      timestamp: new Date(),
    });

    return validOrgs;
  }

  /**
   * Run the post-claim action pipeline on orgs in parallel.
   *
   * Each org's actions run sequentially (in order), but different orgs
   * are processed concurrently. If any action throws for an org, that
   * org is filtered out of the result. Actions that fail non-fatally
   * should catch internally and log rather than throw.
   */
  private async handlePostClaims(orgs: PoolOrg[], actions: PostClaimAction[]): Promise<PoolOrg[]> {
    if (actions.length === 0) return orgs;

    const results = await Promise.allSettled(orgs.map(async org => {
      for (const action of actions) {
        // eslint-disable-next-line no-await-in-loop -- actions are sequential per org
        await action(org);
      }

      return org;
    }));

    return results
    .filter((r): r is PromiseFulfilledResult<PoolOrg> => {
      if (r.status === 'rejected') {
        const error = r.reason instanceof Error ? r.reason.message : String(r.reason);
        this.logger?.warn(`Post-claim action failed, filtering org: ${error}`);
        return false;
      }

      return true;
    })
    .map(r => r.value);
  }
}
