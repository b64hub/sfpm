import type {Logger} from '@b64/sfpm-core';

import type {ScratchOrg} from '../org/scratch/types.js';
import type {
  PoolConfig,
  PoolFetchAllOptions,
  PoolFetchOptions,
  PoolPrerequisiteChecker,
} from '../types.js';
import type PoolFetcher from './pool-fetcher.js';
import type {PoolProvisionResult} from './pool-manager.js';
import type PoolManager from './pool-manager.js';

// ============================================================================
// PoolService
// ============================================================================

/**
 * High-level pool service composing provisioning and fetching.
 *
 * Replaces the legacy `PoolBaseImpl` inheritance hierarchy. Instead of
 * a template method (`checkPrerequisites()` → `onExec()`), this service
 * composes focused collaborators via dependency injection:
 *
 * - **PoolManager** — provisions new scratch orgs to fill pools
 * - **PoolFetcher** — fetches and claims orgs from existing pools
 * - **PoolPrerequisiteChecker** — validates DevHub configuration
 *
 * The service is intentionally thin — it coordinates cross-cutting
 * concerns (prerequisite validation) and delegates to the appropriate
 * collaborator. For fine-grained progress tracking, attach event
 * listeners directly to the `PoolManager` or `PoolFetcher` instances.
 *
 * @example
 * ```ts
 * const service = new PoolService(poolManager, poolFetcher, prereqChecker, logger);
 *
 * // Provision a pool (validates prerequisites first)
 * const result = await service.provision(poolConfig);
 *
 * // Fetch an org from a pool
 * const org = await service.fetch({ tag: 'dev-pool' });
 * ```
 */
export default class PoolService {
  constructor(
    private readonly manager: PoolManager,
    private readonly fetcher: PoolFetcher,
    private readonly prerequisiteChecker?: PoolPrerequisiteChecker,
    private readonly logger?: Logger,
  ) {}

  // --------------------------------------------------------------------------
  // Public API
  // --------------------------------------------------------------------------

  /** The underlying pool fetcher — use for direct event access. */
  public get poolFetcher(): PoolFetcher {
    return this.fetcher;
  }

  /** The underlying pool manager — use for direct event access. */
  public get poolManager(): PoolManager {
    return this.manager;
  }

  /**
   * Fetch a single scratch org from a pool.
   *
   * Delegates to `PoolFetcher.fetch()`. Claims the org using
   * optimistic concurrency and authenticates if possible.
   */
  public async fetch(options: PoolFetchOptions): Promise<ScratchOrg> {
    return this.fetcher.fetch(options);
  }

  /**
   * Fetch multiple scratch orgs from a pool.
   *
   * Delegates to `PoolFetcher.fetchAll()`. Does not claim individual
   * orgs — the caller manages allocation status.
   */
  public async fetchAll(options: PoolFetchAllOptions): Promise<ScratchOrg[]> {
    return this.fetcher.fetchAll(options);
  }

  /**
   * Provision scratch orgs to fill a pool.
   *
   * Runs prerequisite validation before provisioning to ensure the
   * DevHub has the required custom fields and picklist values.
   *
   * @throws When prerequisites are not met or provisioning fails
   */
  public async provision(config: PoolConfig): Promise<PoolProvisionResult> {
    await this.validatePrerequisites();
    return this.manager.provision(config);
  }

  /**
   * Validate that the DevHub meets pool operation prerequisites.
   *
   * Skips validation if no `PoolPrerequisiteChecker` was provided.
   * Callers can invoke this directly if they need to check prerequisites
   * without performing an operation.
   */
  public async validatePrerequisites(): Promise<void> {
    if (!this.prerequisiteChecker) {
      return;
    }

    this.logger?.debug('Validating DevHub prerequisites...');
    await this.prerequisiteChecker.validate();
    this.logger?.debug('Prerequisites validated');
  }
}
