import type {Logger} from '@b64/sfpm-core';

import {EventEmitter} from 'node:events';

import type OrgService from '../org/org-service.js';
import type {ScratchOrg} from '../org/scratch/types.js';

import {
  DEFAULT_POOL_SIZING,
  DEFAULT_SCRATCH_ORG,
  OrgError,
  type PoolConfig,
  type PoolDeleteOptions,
  type PoolInfoProvider,
  type PoolOrgLoggerFactory,
  type PoolOrgRecord,
  type PoolOrgSource,
  type PoolOrgTask,
  type PoolOrgTaskResult,
  type PoolSizingConfig,
} from '../types.js';

// ============================================================================
// Constants
// ============================================================================

/** Default concurrency when batchSize is not configured. */
const DEFAULT_CONCURRENCY = DEFAULT_POOL_SIZING.batchSize;

// ============================================================================
// Pool Manager Types
// ============================================================================

/**
 * Result from a single org provisioning attempt.
 */
export interface OrgProvisionResult {
  /** Error message if provisioning failed */
  error?: string;
  /** The provisioned org, if successful */
  org?: ScratchOrg;
  /** Whether this was a timeout failure */
  timedOut?: boolean;
}

/**
 * Result from deleting scratch orgs from a pool.
 */
export interface PoolDeleteResult {
  /** Orgs that were successfully deleted */
  deleted: ScratchOrg[];
  /** Total elapsed time in milliseconds */
  elapsedMs: number;
  /** Individual deletion error messages */
  errors: string[];
  /** The pool tag */
  tag: string;
}

/**
 * Final result returned by `PoolManager.provision()`.
 */
export interface PoolProvisionResult {
  /** Total elapsed time in milliseconds */
  elapsedMs: number;
  /** Individual failure messages */
  errors: string[];
  /** Number of orgs that failed to provision */
  failed: number;
  /** Successfully provisioned orgs */
  succeeded: ScratchOrg[];
  /** The pool tag */
  tag: string;
  /** Per-org task execution results (omitted when no tasks configured) */
  taskResults?: OrgTaskSummary[];
}

/**
 * Summary of all task results for a single scratch org.
 */
export interface OrgTaskSummary {
  /** Individual task results in execution order */
  results: Array<{error?: string; success: boolean; task: string}>;
  /** Whether all tasks succeeded */
  success: boolean;
  /** The org these tasks ran against */
  username: string;
}

/**
 * Event map for PoolManager. Provides progress tracking during
 * the provisioning lifecycle.
 */
export interface PoolManagerEvents {
  'pool:allocation:computed': [payload: {currentAllocation: number; remaining: number; tag: string; toAllocate: number}];
  'pool:delete:complete': [payload: PoolDeleteResult];
  'pool:delete:start': [payload: {count: number; tag: string; timestamp: Date}];
  'pool:org:created': [payload: {alias: string; index: number; timestamp: Date; total: number}];
  'pool:org:deleted': [payload: {timestamp: Date; username: string}];
  'pool:org:discarded': [payload: {reason: string; timestamp: Date; username: string}];
  'pool:org:failed': [payload: {alias: string; error: string; index: number; timedOut: boolean; timestamp: Date}];
  'pool:org:validated': [payload: {timestamp: Date; username: string}];
  'pool:provision:complete': [payload: PoolProvisionResult];
  'pool:provision:start': [payload: {tag: string; timestamp: Date; toAllocate: number}];
  'pool:task:complete': [payload: {success: boolean; task: string; timestamp: Date; username: string}];
  'pool:task:error': [payload: {error: string; task: string; timestamp: Date; username: string}];
  'pool:task:start': [payload: {task: string; timestamp: Date; username: string}];
}

// ============================================================================
// PoolManager
// ============================================================================

/**
 * Options for constructing a `PoolManager`.
 */
export interface PoolManagerOptions {
  /** Logger for the pool manager itself */
  logger?: Logger;
  /** Factory for creating per-org scoped loggers during task execution */
  loggerFactory?: PoolOrgLoggerFactory;
  /** Service for creating scratch orgs */
  orgService: OrgService;
  /** Provider for pool state queries */
  poolInfo: PoolInfoProvider;
  /** Data source for querying pool scratch orgs (required for `delete()`) */
  poolOrgSource?: PoolOrgSource;
  /** Tasks to run on each provisioned org (executed in order) */
  tasks?: PoolOrgTask[];
}

/**
 * Manages the lifecycle of a scratch org pool.
 *
 * Migrated from the legacy `PoolCreateImpl`. Key differences:
 *
 * - **No Bottleneck dependency** — uses a simple concurrency-limited
 *   Promise pattern. Salesforce DevHub has concurrent request limits,
 *   so we cap parallelism at `batchSize` (default: 5) but don't need
 *   a heavyweight rate-limiter library for this.
 *
 * - **Composition over inheritance** — takes `OrgService` and
 *   `PoolInfoProvider` via constructor instead of extending a base class.
 *
 * - **Separated concerns** — pool config vs runtime state, org creation
 *   vs pool metadata management, progress events vs logging.
 *
 * - **Org-type agnostic core** — while currently scratch-org focused,
 *   the provisioning pattern (compute allocation → create orgs → validate
 *   → register in pool) can extend to sandboxes by swapping the
 *   creation strategy.
 *
 * @example
 * ```ts
 * const manager = new PoolManager({
 *   loggerFactory: fileLoggerFactory,
 *   orgService,
 *   poolInfo: poolInfoProvider,
 *   tasks: [deployTask, scriptTask],
 * });
 * manager.on('pool:org:created', (p) => console.log(`Created ${p.alias}`));
 *
 * const result = await manager.provision(poolConfig);
 * console.log(`${result.succeeded.length} orgs provisioned`);
 * ```
 */
export default class PoolManager extends EventEmitter<PoolManagerEvents> {
  private readonly logger?: Logger;
  private readonly loggerFactory?: PoolOrgLoggerFactory;
  private readonly orgService: OrgService;
  private readonly poolInfo: PoolInfoProvider;
  private readonly poolOrgSource?: PoolOrgSource;
  private readonly tasks: PoolOrgTask[];

  constructor(options: PoolManagerOptions) {
    super();
    this.loggerFactory = options.loggerFactory;
    this.logger = options.logger;
    this.orgService = options.orgService;
    this.poolInfo = options.poolInfo;
    this.poolOrgSource = options.poolOrgSource;
    this.tasks = options.tasks ?? [];
  }

  // --------------------------------------------------------------------------
  // Public API
  // --------------------------------------------------------------------------

  /**
   * Compute how many scratch orgs should be allocated for a pool.
   *
   * Factors in the current pool count, DevHub remaining capacity,
   * and the pool's configured max allocation.
   */
  public async computeAllocation(config: PoolConfig): Promise<PoolAllocation> {
    const [remaining, activeCount] = await Promise.all([
      this.poolInfo.getRemainingCapacity(),
      this.poolInfo.getActiveCountByTag(config.tag),
    ]);

    const allocation = computeOrgAllocation(remaining, activeCount, config.sizing);

    this.emit('pool:allocation:computed', {
      currentAllocation: activeCount,
      remaining,
      tag: config.tag,
      toAllocate: allocation.toAllocate,
    });

    this.logger?.info(`Pool "${config.tag}": current=${activeCount}, remaining=${remaining}, toAllocate=${allocation.toAllocate}`);

    return allocation;
  }

  /**
   * Delete scratch orgs from a pool.
   *
   * Queries all orgs matching the pool tag, optionally filtering to
   * only 'In Progress' orgs or orgs owned by the current user. Each
   * matching org with a valid `recordId` is deleted via `OrgService`.
   *
   * @param options - Tag, filter, and ownership options
   * @returns Summary of deleted orgs and any errors
   * @throws {OrgError} When `poolOrgSource` was not provided at construction
   */
  public async delete(options: PoolDeleteOptions): Promise<PoolDeleteResult> {
    if (!this.poolOrgSource) {
      throw new OrgError('delete', 'PoolOrgSource is required for delete operations — provide it in PoolManagerOptions');
    }

    const startTime = Date.now();
    const {inProgressOnly, myPool, tag} = options;

    this.logger?.info(`Querying pool "${tag}" for orgs to delete...`);

    // 1. Query orgs from the pool
    let orgs = await this.poolOrgSource.getOrgsByTag(tag, myPool);

    // 2. Apply status filter
    if (inProgressOnly) {
      orgs = orgs.filter(org => org.status === 'In Progress');
    }

    if (orgs.length === 0) {
      this.logger?.info(`No orgs found in pool "${tag}" matching the specified criteria`);
      return {
        deleted: [],
        elapsedMs: Date.now() - startTime,
        errors: [],
        tag,
      };
    }

    this.emit('pool:delete:start', {
      count: orgs.length,
      tag,
      timestamp: new Date(),
    });

    this.logger?.info(`Deleting ${orgs.length} org(s) from pool "${tag}"...`);

    // 3. Delete each org individually (some may lack recordIds or fail)
    const deleted: ScratchOrg[] = [];
    const errors: string[] = [];

    for (const org of orgs) {
      if (!org.recordId) {
        errors.push(`Org ${org.username ?? 'unknown'} has no recordId — skipping`);
        continue;
      }

      try {
        // eslint-disable-next-line no-await-in-loop -- sequential deletion avoids overwhelming the DevHub API
        await this.orgService.deleteScratchOrgs([org.recordId]);
        org.status = 'Deleted';
        deleted.push(org);

        this.emit('pool:org:deleted', {
          timestamp: new Date(),
          username: org.username!,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        errors.push(`Failed to delete org ${org.username ?? org.recordId}: ${message}`);
        this.logger?.warn(`Failed to delete org ${org.username ?? org.recordId}: ${message}`);
      }
    }

    const elapsedMs = Date.now() - startTime;
    const result: PoolDeleteResult = {
      deleted,
      elapsedMs,
      errors,
      tag,
    };

    this.emit('pool:delete:complete', result);
    this.logger?.info(`Deleted ${deleted.length} org(s) from pool "${tag}" in ${elapsedMs}ms`);

    return result;
  }

  /**
   * Provision scratch orgs to fill the pool up to its configured capacity.
   *
   * Flow:
   * 1. Query current pool state and DevHub limits
   * 2. Compute how many orgs to allocate
   * 3. Create orgs concurrently (capped at `batchSize`)
   * 4. Validate created orgs are actually active
   * 5. Register them in the pool with metadata
   *
   * @throws {OrgError} When zero orgs could be provisioned
   */
  public async provision(config: PoolConfig): Promise<PoolProvisionResult> {
    const concurrency = config.sizing.batchSize ?? DEFAULT_CONCURRENCY;
    const startTime = Date.now();

    // 1. Compute allocation
    const allocation = await this.computeAllocation(config);

    if (allocation.toAllocate === 0) {
      return this.handleZeroAllocation(config, allocation, startTime);
    }

    this.emit('pool:provision:start', {
      tag: config.tag,
      timestamp: new Date(),
      toAllocate: allocation.toAllocate,
    });

    this.logger?.info(`Provisioning ${allocation.toAllocate} scratch org(s) for pool "${config.tag}"...`);

    // 2. Create scratch orgs with concurrency limit
    const results = await this.createOrgsWithConcurrency(
      config,
      allocation.toAllocate,
      concurrency,
    );

    const succeeded = results
    .filter((r): r is OrgProvisionResult & {org: ScratchOrg} => Boolean(r.org))
    .map(r => r.org);
    const errors = results.filter(r => r.error).map(r => r.error!);

    this.logger?.info(`Created ${succeeded.length} of ${allocation.toAllocate} org(s), ${errors.length} failed`);

    if (succeeded.length === 0) {
      throw new OrgError('create', 'All scratch org provisioning attempts failed', {
        context: {errors, tag: config.tag},
      });
    }

    // 3. Validate orgs are actually active (Salesforce sometimes marks them deleted)
    const validOrgs = await this.validateOrgs(succeeded);

    if (validOrgs.length === 0) {
      throw new OrgError('create', 'All provisioned orgs were found to be inactive', {
        context: {tag: config.tag},
      });
    }

    // 4. Fetch record IDs and register in pool
    const registeredOrgs = await this.registerInPool(validOrgs, config.tag);

    // 5. Run preparation tasks on provisioned orgs
    let taskResults: OrgTaskSummary[] | undefined;
    if (this.tasks.length > 0) {
      taskResults = await this.runTasksOnOrgs(registeredOrgs, concurrency);
    }

    const elapsedMs = Date.now() - startTime;
    const result: PoolProvisionResult = {
      elapsedMs,
      errors,
      failed: allocation.toAllocate - registeredOrgs.length,
      succeeded: registeredOrgs,
      tag: config.tag,
      taskResults,
    };

    this.emit('pool:provision:complete', result);
    return result;
  }

  // --------------------------------------------------------------------------
  // Private — Org creation
  // --------------------------------------------------------------------------

  /**
   * Create multiple orgs concurrently, capped at `concurrency`.
   *
   * Replaces the legacy Bottleneck-based approach. Salesforce DevHub has
   * concurrent API request limits, so we use a simple batch pattern
   * instead of firing all requests at once.
   *
   * We process in sequential batches of size `concurrency`. Within each
   * batch, all requests run in parallel. This gives us deterministic
   * concurrency control without any external dependencies.
   */
  private async createOrgsWithConcurrency(
    config: PoolConfig,
    count: number,
    concurrency: number,
  ): Promise<OrgProvisionResult[]> {
    // Build all batch definitions up front
    const batches: Array<{alias: string; index: number;}[]> = [];
    for (let batchStart = 0; batchStart < count; batchStart += concurrency) {
      const batchEnd = Math.min(batchStart + concurrency, count);
      const batch = Array.from({length: batchEnd - batchStart}, (_, i) => ({
        alias: `SO${batchStart + i + 1}`,
        index: batchStart + i,
      }));
      batches.push(batch);
    }

    // Process batches sequentially, each batch runs in parallel
    const allResults: OrgProvisionResult[] = [];

    for (const batch of batches) {
      const batchPromises = batch.map(({alias, index}) =>
        this.createSingleOrg(config, alias, index, count));
      // eslint-disable-next-line no-await-in-loop -- intentional sequential batching for API rate limits
      const settled = await Promise.allSettled(batchPromises);
      const results = settled.map(s =>
        s.status === 'fulfilled' ? s.value : {error: String(s.reason)});
      allResults.push(...results);
    }

    return allResults;
  }

  /**
   * Create a single scratch org and return the result.
   * Never throws — returns an `OrgProvisionResult` with error info on failure.
   */
  private async createSingleOrg(
    config: PoolConfig,
    alias: string,
    index: number,
    total: number,
  ): Promise<OrgProvisionResult> {
    try {
      const org = await this.orgService.createScratchOrg({
        alias,
        definitionFile: config.scratchOrg.definitionFile,
        expiryDays: config.scratchOrg.expiryDays ?? DEFAULT_SCRATCH_ORG.expiryDays,
        noAncestors: config.scratchOrg.noAncestors ?? DEFAULT_SCRATCH_ORG.noAncestors,
        waitMinutes: config.scratchOrg.waitMinutes ?? DEFAULT_SCRATCH_ORG.waitMinutes,
      });

      org.tag = config.tag;

      this.emit('pool:org:created', {
        alias,
        index: index + 1,
        timestamp: new Date(),
        total,
      });

      return {org};
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const timedOut = message.includes('timed out');

      this.emit('pool:org:failed', {
        alias,
        error: message,
        index: index + 1,
        timedOut,
        timestamp: new Date(),
      });

      if (timedOut) {
        this.logger?.warn(`Org "${alias}" creation timed out — consider increasing waitMinutes (current: ${config.scratchOrg.waitMinutes ?? DEFAULT_SCRATCH_ORG.waitMinutes}min)`);
      } else {
        this.logger?.warn(`Org "${alias}" creation failed: ${message}`);
      }

      return {error: message, timedOut};
    }
  }

  // --------------------------------------------------------------------------
  // Private helpers
  // --------------------------------------------------------------------------

  /**
   * Execute a single task, catching errors so one task can't crash
   * the entire provisioning run.
   */
  private async executeSingleTask(
    task: PoolOrgTask,
    org: ScratchOrg,
    orgLogger?: Logger,
  ): Promise<PoolOrgTaskResult> {
    try {
      return await task.execute(org, orgLogger ?? noopLogger);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      orgLogger?.error(`Task "${task.name}" failed: ${message}`);
      return {error: message, success: false};
    }
  }

  private handleZeroAllocation(
    config: PoolConfig,
    allocation: PoolAllocation,
    startTime: number,
  ): PoolProvisionResult {
    const reason = allocation.remaining > 0
      ? `Pool "${config.tag}" is at maximum capacity (${config.sizing.maxAllocation})`
      : 'No remaining scratch org capacity on the DevHub';

    this.logger?.info(reason);

    return {
      elapsedMs: Date.now() - startTime,
      errors: [reason],
      failed: 0,
      succeeded: [],
      tag: config.tag,
    };
  }

  // --------------------------------------------------------------------------
  // Private — Task execution
  // --------------------------------------------------------------------------

  /**
   * Fetch record IDs from the DevHub and update pool metadata.
   */
  private async registerInPool(orgs: ScratchOrg[], tag: string): Promise<ScratchOrg[]> {
    // Enrich orgs with their DevHub record IDs
    const enrichedOrgs = await this.poolInfo.getRecordIds(orgs);

    const records: PoolOrgRecord[] = enrichedOrgs
    .filter(org => org.recordId)
    .map(org => ({
      allocationStatus: 'In Progress' as const,
      id: org.recordId!,
      password: org.password,
      poolTag: tag,
    }));

    if (records.length > 0) {
      await this.poolInfo.updatePoolMetadata(records);
      this.logger?.debug(`Registered ${records.length} org(s) in pool "${tag}"`);
    }

    return enrichedOrgs.filter(org => org.recordId);
  }

  /**
   * Run preparation tasks on provisioned orgs with concurrency control.
   *
   * Each org gets a scoped logger from the `PoolOrgLoggerFactory`.
   * Tasks run sequentially per org (order matters — deploy before
   * scripts), but multiple orgs are processed in parallel up to
   * `concurrency`.
   */
  private async runTasksOnOrgs(
    orgs: ScratchOrg[],
    concurrency: number,
  ): Promise<OrgTaskSummary[]> {
    this.logger?.info(`Running ${this.tasks.length} task(s) on ${orgs.length} org(s)...`);

    const summaries: OrgTaskSummary[] = [];

    // Process orgs in batches (same pattern as org creation)
    for (let i = 0; i < orgs.length; i += concurrency) {
      const batch = orgs.slice(i, i + concurrency);
      // eslint-disable-next-line no-await-in-loop -- intentional sequential batching for API rate limits
      const batchResults = await Promise.all(batch.map(org => this.runTasksOnSingleOrg(org)));
      summaries.push(...batchResults);
    }

    // Clean up logger factory resources
    if (this.loggerFactory?.dispose) {
      await this.loggerFactory.dispose();
    }

    const succeeded = summaries.filter(s => s.success).length;
    this.logger?.info(`Tasks complete: ${succeeded}/${summaries.length} org(s) fully prepared`);

    return summaries;
  }

  /**
   * Run all registered tasks sequentially on a single scratch org.
   *
   * Creates a scoped logger for the org, then executes each task in
   * order. If a task fails and `continueOnError` is false, remaining
   * tasks are skipped.
   */
  private async runTasksOnSingleOrg(org: ScratchOrg): Promise<OrgTaskSummary> {
    const orgLogger = this.loggerFactory?.create(org) ?? this.logger;
    const results: Array<{error?: string; success: boolean; task: string}> = [];
    let aborted = false;

    for (const task of this.tasks) {
      if (aborted) {
        results.push({error: 'Skipped (previous task failed)', success: false, task: task.name});
        continue;
      }

      this.emit('pool:task:start', {
        task: task.name,
        timestamp: new Date(),
        username: org.username!,
      });

      // eslint-disable-next-line no-await-in-loop -- tasks must run sequentially per org (order matters)
      const taskResult = await this.executeSingleTask(task, org, orgLogger);
      results.push({error: taskResult.error, success: taskResult.success, task: task.name});

      if (taskResult.success) {
        this.emit('pool:task:complete', {
          success: true,
          task: task.name,
          timestamp: new Date(),
          username: org.username!,
        });
      } else {
        this.emit('pool:task:error', {
          error: taskResult.error ?? 'Unknown error',
          task: task.name,
          timestamp: new Date(),
          username: org.username!,
        });

        if (!task.continueOnError) {
          aborted = true;
        }
      }
    }

    return {
      results,
      success: results.every(r => r.success),
      username: org.username!,
    };
  }

  /**
   * Validate that provisioned orgs are actually active.
   *
   * Salesforce can sometimes report orgs as created but they end up
   * in a "Deleted" state. We filter those out before registering
   * them in the pool.
   *
   * All validations run in parallel since they are independent queries.
   */
  private async validateOrgs(orgs: ScratchOrg[]): Promise<ScratchOrg[]> {
    const results = await Promise.all(orgs.map(org => this.validateSingleOrg(org)));

    return results.filter((org): org is ScratchOrg => org !== null);
  }

  /**
   * Validate a single org is active. Returns the org if valid, null if not.
   */
  private async validateSingleOrg(org: ScratchOrg): Promise<null | ScratchOrg> {
    try {
      const isActive = await this.poolInfo.isOrgActive(org.username!);

      if (isActive) {
        this.emit('pool:org:validated', {
          timestamp: new Date(),
          username: org.username!,
        });
        return org;
      }

      this.emit('pool:org:discarded', {
        reason: 'Org has status "Deleted"',
        timestamp: new Date(),
        username: org.username!,
      });
      this.logger?.warn(`Discarding org ${org.username} — reported as deleted`);
      return null;
    } catch (error) {
      this.emit('pool:org:discarded', {
        reason: error instanceof Error ? error.message : String(error),
        timestamp: new Date(),
        username: org.username!,
      });
      this.logger?.warn(`Unable to verify org ${org.username}, discarding: ${error instanceof Error ? error.message : error}`);
      return null;
    }
  }
}

// ============================================================================
// Pure allocation logic (exported for testing)
// ============================================================================

/**
 * Result of an allocation computation.
 */
export interface PoolAllocation {
  /** Current number of active orgs in the pool */
  currentAllocation: number;
  /** Remaining scratch org capacity on the DevHub */
  remaining: number;
  /** Number of orgs to create */
  toAllocate: number;
  /** Gap to reach max allocation */
  toSatisfyMax: number;
}

/**
 * Compute how many orgs to allocate given current state and config.
 *
 * Pure function — no side effects, easy to unit test.
 */
export function computeOrgAllocation(
  remainingScratchOrgs: number,
  currentActiveCount: number,
  sizing: PoolSizingConfig,
): PoolAllocation {
  const toSatisfyMax = Math.max(0, sizing.maxAllocation - currentActiveCount);

  let toAllocate = 0;
  if (toSatisfyMax > 0) {
    toAllocate = Math.min(toSatisfyMax, remainingScratchOrgs);
  }

  return {
    currentAllocation: currentActiveCount,
    remaining: remainingScratchOrgs,
    toAllocate,
    toSatisfyMax,
  };
}

// ============================================================================
// Internal helpers
// ============================================================================

/** Silent logger used when no logger or factory is provided. */
const noop = (): void => {};
const noopLogger: Logger = {
  debug: noop,
  error: noop,
  info: noop,
  log: noop,
  trace: noop,
  warn: noop,
};
