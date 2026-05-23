import type {Logger} from '@b64hub/sfpm-core';

import {OrgTypes} from '@salesforce/core';
import {EventEmitter} from 'node:events';

import type {OrgCreateOptions, OrgProvider} from '../org/org-provider.js';
import type {PoolOrg, PoolOrgRecord} from '../org/pool-org.js';

import {
  AllocationStatus,
  OrgError,
} from '../org/types.js';
import {
  DEFAULT_POOL_SIZING,
  type PoolConfig,
  type PoolDeleteOptions,
  type PoolOrgLoggerFactory,
  type PoolOrgTask,
  type PoolOrgTaskResult,
  type PoolSize,
} from './types.js';

// ============================================================================
// Constants
// ============================================================================

/** Default concurrency when batch is not configured. */
const DEFAULT_CONCURRENCY = DEFAULT_POOL_SIZING.batch;

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
  org?: PoolOrg;
  /** Whether this was a timeout failure */
  timedOut?: boolean;
}

/**
 * Result from deleting scratch orgs from a pool.
 */
export interface PoolDeleteResult {
  /** Orgs that were successfully deleted */
  deleted: PoolOrg[];
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
  succeeded: PoolOrg[];
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
  /**
   * Provider for org-type-specific operations (create, delete, query, etc.).
   *
   * The provider encapsulates all interaction with the hub org's SObjects
   * (ScratchOrgInfo / SandboxInfo) so the pool manager stays org-type agnostic.
   */
  provider: OrgProvider;
  /** Tasks to run on each provisioned org (executed in order) */
  tasks?: PoolOrgTask[];
}

/**
 * Manages the lifecycle of a scratch org pool.
 *
 *   Uses a simple concurrency-limited
 *   Promise pattern. Salesforce DevHub has concurrent request limits,
 *   so we cap parallelism at `batchSize` (default: 5) but don't need
 *   a heavyweight rate-limiter library for this.
 *
 * @example
 * ```ts
 * const manager = new PoolManager({
 *   loggerFactory: fileLoggerFactory,
 *   provider,
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
  private readonly provider: OrgProvider;
  private readonly tasks: PoolOrgTask[];

  constructor(options: PoolManagerOptions) {
    super();
    this.loggerFactory = options.loggerFactory;
    this.logger = options.logger;
    this.provider = options.provider;
    this.tasks = options.tasks ?? [];
  }

  /**
   * Compute how many scratch orgs should be allocated for a pool.
   *
   * Factors in the current pool count, DevHub remaining capacity,
   * and the pool's configured max allocation.
   */
  public async computeAllocation(tag: string, config: PoolConfig): Promise<PoolAllocation> {
    const [remaining, activeCount] = await Promise.all([
      this.provider.getRemainingCapacity(),
      this.provider.getActiveCountByTag(tag),
    ]);

    const allocation = computeOrgAllocation(remaining, activeCount, config.sizing);

    this.emit('pool:allocation:computed', {
      currentAllocation: activeCount,
      remaining,
      tag,
      toAllocate: allocation.toAllocate,
    });

    this.logger?.info(`Pool "${tag}": current=${activeCount}, remaining=${remaining}, toAllocate=${allocation.toAllocate}`);

    return allocation;
  }

  /**
   * Delete scratch orgs from a pool.
   *
   * Queries all orgs matching the pool tag, optionally filtering to
   * only 'In_Progress' orgs or orgs owned by the current user. Each
   * matching org with a valid `orgId` is deleted via the provider.
   *
   * @param options - Tag, filter, and ownership options
   * @returns Summary of deleted orgs and any errors
   * @throws {OrgError} When `poolOrgSource` was not provided at construction
   */
  public async delete(tag: string, options?: PoolDeleteOptions): Promise<PoolDeleteResult> {
    const startTime = Date.now();
    const {inProgressOnly, myPool} = options ?? {};

    this.logger?.info(`Querying pool "${tag}" for orgs to delete...`);

    // 1. Query orgs from the pool
    let orgs = await this.provider.getOrgsByTag(tag, myPool);

    // 2. Apply status filter
    if (inProgressOnly) {
      orgs = orgs.filter(org => org.pool?.status === AllocationStatus.InProgress);
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
    const deleted: PoolOrg[] = [];
    const errors: string[] = [];

    for (const org of orgs) {
      if (!org.recordId) {
        errors.push(`Org ${org.auth.username ?? 'unknown'} has no recordId — skipping`);
        continue;
      }

      try {
        // eslint-disable-next-line no-await-in-loop -- sequential deletion avoids overwhelming the DevHub API
        await this.provider.deleteOrgs([org.recordId]);
        if (org.pool) {
          org.pool.status = AllocationStatus.Return;
        }

        deleted.push(org);

        this.emit('pool:org:deleted', {
          timestamp: new Date(),
          username: org.auth.username!,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        errors.push(`Failed to delete org ${org.auth.username ?? org.recordId}: ${message}`);
        this.logger?.warn(`Failed to delete org ${org.auth.username ?? org.recordId}: ${message}`);
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
   * List all orgs in a pool regardless of status.
   *
   * Delegates to the provider's `getOrgsByTag()` query. Optionally
   * filters to orgs created by the current user.
   *
   * @param tag - Pool tag to query
   * @param myPool - When true, only return orgs created by the current user
   * @returns All pool orgs with metadata populated
   */
  public async list(tag?: string, myPool?: boolean): Promise<PoolOrg[]> {
    this.logger?.info(`Listing orgs for pool${tag ? ` "${tag}"` : ''}...`);
    return this.provider.getOrgsByTag(tag, myPool);
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
  public async provision(tag: string, config: PoolConfig): Promise<PoolProvisionResult> {
    const concurrency = config.sizing.batch ?? DEFAULT_CONCURRENCY;
    const startTime = Date.now();

    // 0. Validate prerequisites
    await this.validatePrerequisites();

    // 1. Compute allocation
    const allocation = await this.computeAllocation(tag, config);

    if (allocation.toAllocate === 0) {
      return this.handleZeroAllocation(tag, config, allocation, startTime);
    }

    this.emit('pool:provision:start', {
      tag,
      timestamp: new Date(),
      toAllocate: allocation.toAllocate,
    });

    this.logger?.info(`Provisioning ${allocation.toAllocate} scratch org(s) for pool "${tag}"...`);

    // 2. Create scratch orgs with concurrency limit
    const results = await this.createOrgsWithConcurrency(
      tag,
      config,
      allocation.toAllocate,
      concurrency,
    );

    const succeeded = results
    .filter((r): r is OrgProvisionResult & {org: PoolOrg} => Boolean(r.org))
    .map(r => r.org);
    const errors = results.filter(r => r.error).map(r => r.error!);

    this.logger?.info(`Created ${succeeded.length} of ${allocation.toAllocate} org(s), ${errors.length} failed`);

    if (succeeded.length === 0) {
      throw new OrgError('create', 'All scratch org provisioning attempts failed', {
        context: {errors, tag},
      });
    }

    // 3. Validate orgs are actually active (Salesforce sometimes marks them deleted)
    const validOrgs = await this.validateOrgs(succeeded);

    if (validOrgs.length === 0) {
      throw new OrgError('create', 'All provisioned orgs were found to be inactive', {
        context: {tag},
      });
    }

    // 4. Fetch record IDs and register in pool
    const registeredOrgs = await this.registerInPool(validOrgs, tag);

    // 5. Clean up orgs that were created but couldn't be registered
    const orphanedOrgs = validOrgs.filter(org => !org.recordId);
    if (orphanedOrgs.length > 0) {
      this.logger?.warn(`${orphanedOrgs.length} org(s) created but not registered — cleaning up`);
      await this.cleanupOrphanedOrgs(orphanedOrgs);
    }

    // 6. Run preparation tasks on provisioned orgs
    let taskResults: OrgTaskSummary[] | undefined;
    if (this.tasks.length > 0) {
      taskResults = await this.runTasksOnOrgs(registeredOrgs);
    }

    // 7. Mark successfully prepared orgs as Available
    const availableOrgs = await this.markOrgsAvailable(registeredOrgs, tag, taskResults);

    // 8. Clean up orgs where tasks failed (stuck In_Progress)
    if (taskResults) {
      const failedOrgs = registeredOrgs.filter(org => !availableOrgs.includes(org) && org.recordId);
      if (failedOrgs.length > 0) {
        await this.cleanupFailedOrgs(failedOrgs, tag);
      }
    }

    const elapsedMs = Date.now() - startTime;
    const result: PoolProvisionResult = {
      elapsedMs,
      errors,
      failed: allocation.toAllocate - availableOrgs.length,
      succeeded: availableOrgs,
      tag,
      taskResults,
    };

    this.emit('pool:provision:complete', result);
    return result;
  }

  /**
   * Validate that the DevHub meets pool operation prerequisites.
   *
   * Checks that the DevHub has the required custom fields and picklist
   * values on `ScratchOrgInfo` for pool operations. Call this before
   * provisioning or as a standalone health check.
   *
   * @throws {OrgError} When prerequisites are not met
   */
  public async validatePrerequisites(): Promise<void> {
    this.logger?.debug('Validating devhub prerequisites...');
    await this.provider.validate();
    this.logger?.debug('Prerequisites validated');
  }

  /**
   * Build batch definitions for org creation.
   * @param count The total number of orgs to create.
   * @param concurrency The maximum number of orgs to create concurrently.
   * @returns An array of batches, each containing org aliases and their indices.
   */
  private buildBatchDefinitions(count: number, concurrency: number): Array<{alias: string; index: number;}[]> {
    const batches: Array<{alias: string; index: number;}[]> = [];
    for (let batchStart = 0; batchStart < count; batchStart += concurrency) {
      const batchEnd = Math.min(batchStart + concurrency, count);
      const batch = Array.from({length: batchEnd - batchStart}, (_, i) => ({
        alias: `SO${batchStart + i + 1}`,
        index: batchStart + i,
      }));
      batches.push(batch);
    }

    return batches;
  }

  /**
   * Build `OrgCreateOptions` from the pool config and an alias.
   *
   * Maps the discriminated pool config union to the generic
   * `OrgCreateOptions` used by the provider.
   */
  private buildCreateOptions(config: PoolConfig, alias: string): OrgCreateOptions {
    if (config.type === OrgTypes.Sandbox) {
      return {
        alias,
        definitionFile: config.definitionFile,
        namePattern: config.namePattern,
        waitMinutes: config.waitMinutes,
      };
    }

    return {
      alias,
      definitionfile: config.definitionFile,
      durationDays: config.expiryDays,
      noancestors: config.noAncestors,
      retry: config.maxRetries,
    };
  }

  private async cleanupFailedOrgs(orgs: PoolOrg[], tag: string): Promise<void> {
    this.logger?.info(`Cleaning up ${orgs.length} org(s) that failed tasks in pool "${tag}"`);

    const undeleted: PoolOrg[] = [];

    for (const org of orgs) {
      try {
        // eslint-disable-next-line no-await-in-loop -- sequential deletion avoids overwhelming the DevHub API
        await this.provider.deleteOrgs([org.recordId!]);

        this.emit('pool:org:deleted', {
          timestamp: new Date(),
          username: org.auth.username!,
        });

        this.logger?.debug(`Deleted failed org ${org.auth.username}`);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.logger?.warn(`Failed to delete org ${org.auth.username ?? org.recordId}: ${message}`);
        undeleted.push(org);
      }
    }

    // Fallback: mark undeleted orgs as Available rather than leaving them stuck In_Progress.
    // A partially prepared org is preferable to a permanently orphaned one.
    if (undeleted.length > 0) {
      this.logger?.warn(`Marking ${undeleted.length} undeleted org(s) as Available to prevent In_Progress leak`);
      try {
        await this.markOrgsAvailable(undeleted, tag);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.logger?.error(`Failed to mark orgs as Available — orgs may be stuck as In_Progress: ${message}`);
      }
    }
  }

  private async cleanupOrphanedOrgs(orgs: PoolOrg[]): Promise<void> {
    try {
      if (this.provider.cleanupOrgs) {
        await this.provider.cleanupOrgs(orgs);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger?.warn(`Failed to clean up ${orgs.length} orphaned org(s): ${message}`);
    }
  }

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
    tag: string,
    config: PoolConfig,
    count: number,
    concurrency: number,
  ): Promise<OrgProvisionResult[]> {
    const batches: Array<{alias: string; index: number;}[]> = this.buildBatchDefinitions(count, concurrency);
    const allResults: OrgProvisionResult[] = [];

    for (const batch of batches) {
      const batchPromises = batch.map(({alias, index}) =>
        this.createSingleOrg(tag, config, alias, index, count));
      // eslint-disable-next-line no-await-in-loop -- intentional sequential batching for API rate limits
      const settled = await Promise.allSettled(batchPromises);
      const results = settled.map(s =>
        s.status === 'fulfilled' ? s.value : {error: String(s.reason)});
      allResults.push(...results);
    }

    return allResults;
  }

  // --------------------------------------------------------------------------
  // Private helpers
  // --------------------------------------------------------------------------

  /**
   * Create a single org and return the result.
   * Never throws — returns an `OrgProvisionResult` with error info on failure.
   */
  private async createSingleOrg(
    tag: string,
    config: PoolConfig,
    alias: string,
    index: number,
    total: number,
  ): Promise<OrgProvisionResult> {
    try {
      const createOptions = this.buildCreateOptions(config, alias);
      const org = await this.provider.createOrg(createOptions);

      org.pool = {status: AllocationStatus.InProgress, tag, timestamp: Date.now()};

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
      const {waitMinutes} = config;

      this.emit('pool:org:failed', {
        alias,
        error: message,
        index: index + 1,
        timedOut,
        timestamp: new Date(),
      });

      if (timedOut) {
        this.logger?.warn(`Org "${alias}" creation timed out — consider increasing waitMinutes (current: ${waitMinutes ?? 6}min)`);
      } else {
        this.logger?.warn(`Org "${alias}" creation failed: ${message}`);
      }

      return {error: message, timedOut};
    }
  }

  /**
   * Execute a single task, catching errors so one task can't crash
   * the entire provisioning run.
   */
  private async executeSingleTask(
    task: PoolOrgTask,
    org: PoolOrg,
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
    tag: string,
    config: PoolConfig,
    allocation: PoolAllocation,
    startTime: number,
  ): PoolProvisionResult {
    const reason = allocation.remaining > 0
      ? `Pool "${tag}" is at maximum capacity (${config.sizing.max})`
      : 'No remaining scratch org capacity on the DevHub';

    this.logger?.info(reason);

    return {
      elapsedMs: Date.now() - startTime,
      errors: [reason],
      failed: 0,
      succeeded: [],
      tag,
    };
  }

  // --------------------------------------------------------------------------
  // Private — Task execution
  // --------------------------------------------------------------------------

  /**
   * Transition orgs from In_Progress to Available after tasks complete.
   *
   * When tasks are configured, only orgs where all tasks succeeded are
   * marked Available. Orgs with failed tasks remain In_Progress (visible
   * in `pool list` but not claimable by `getAvailableByTag`).
   *
   * When no tasks are configured, all orgs are marked Available.
   */
  private async markOrgsAvailable(
    orgs: PoolOrg[],
    tag: string,
    taskResults?: OrgTaskSummary[],
  ): Promise<PoolOrg[]> {
    // Determine which orgs succeeded
    let successfulOrgs: PoolOrg[];
    if (taskResults) {
      const succeededUsernames = new Set(taskResults.filter(r => r.success).map(r => r.username));
      successfulOrgs = orgs.filter(org => succeededUsernames.has(org.auth.username));
    } else {
      successfulOrgs = orgs;
    }

    if (successfulOrgs.length === 0) {
      this.logger?.warn('No orgs to mark as Available — all tasks failed');
      return [];
    }

    const records: PoolOrgRecord[] = successfulOrgs
    .filter(org => org.recordId)
    .map(org => ({
      allocationStatus: AllocationStatus.Available as const,
      authUrl: org.auth.authUrl,
      id: org.recordId!,
      poolTag: tag,
    }));

    if (records.length > 0) {
      await this.provider.updatePoolMetadata(records);
      this.logger?.info(`Marked ${records.length} org(s) as Available in pool "${tag}"`);
    }

    return successfulOrgs;
  }

  /**
   * Fetch record IDs from the DevHub and update pool metadata.
   */
  private async registerInPool(orgs: PoolOrg[], tag: string): Promise<PoolOrg[]> {
    // Enrich orgs with their DevHub record IDs
    const enrichedOrgs = await this.provider.getRecordIds(orgs);

    const records: PoolOrgRecord[] = enrichedOrgs
    .filter(org => org.recordId)
    .map(org => ({
      allocationStatus: AllocationStatus.InProgress as const,
      authUrl: org.auth.authUrl,
      id: org.recordId!,
      poolTag: tag,
    }));

    if (records.length > 0) {
      await this.provider.updatePoolMetadata(records);
      this.logger?.debug(`Registered ${records.length} org(s) in pool "${tag}" as In_Progress`);
    }

    return enrichedOrgs.filter(org => org.recordId);
  }

  /**
   * Run preparation tasks on provisioned orgs with concurrency control.
   *
   * Each org gets a scoped logger from the `PoolOrgLoggerFactory`.
   * Tasks run sequentially per org (order matters — deploy before
   * scripts), but multiple orgs are processed concurrently up to
   * `concurrency`.
   *
   * Uses a worker-pool pattern: `concurrency` workers pull orgs from
   * a shared queue. As soon as one org finishes, the next starts —
   * unlike the org-creation phase which uses rigid sequential batches
   * (required by Salesforce API limits), task execution benefits from
   * filling slots immediately.
   */
  private async runTasksOnOrgs(orgs: PoolOrg[]): Promise<OrgTaskSummary[]> {
    this.logger?.info(`Running ${this.tasks.length} task(s) on ${orgs.length} org(s)...`);
    const summaries = await Promise.all(orgs.map(org => this.runTasksOnSingleOrg(org)));

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
  private async runTasksOnSingleOrg(org: PoolOrg): Promise<OrgTaskSummary> {
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
        username: org.auth.username!,
      });

      // eslint-disable-next-line no-await-in-loop -- tasks must run sequentially per org (order matters)
      const taskResult = await this.executeSingleTask(task, org, orgLogger);
      results.push({error: taskResult.error, success: taskResult.success, task: task.name});

      if (taskResult.success) {
        this.emit('pool:task:complete', {
          success: true,
          task: task.name,
          timestamp: new Date(),
          username: org.auth.username!,
        });
      } else {
        this.emit('pool:task:error', {
          error: taskResult.error ?? 'Unknown error',
          task: task.name,
          timestamp: new Date(),
          username: org.auth.username!,
        });

        if (!task.continueOnError) {
          aborted = true;
        }
      }
    }

    return {
      results,
      success: results.every((r, i) => r.success || this.tasks[i].continueOnError),
      username: org.auth.username!,
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
  private async validateOrgs(orgs: PoolOrg[]): Promise<PoolOrg[]> {
    const results = await Promise.all(orgs.map(org => this.validateSingleOrg(org)));

    return results.filter((org): org is PoolOrg => org !== null);
  }

  /**
   * Validate a single org is active. Returns the org if valid, null if not.
   */
  private async validateSingleOrg(org: PoolOrg): Promise<null | PoolOrg> {
    try {
      const isActive = await this.provider.isOrgActive(org.auth.username!);

      if (isActive) {
        this.emit('pool:org:validated', {
          timestamp: new Date(),
          username: org.auth.username!,
        });
        return org;
      }

      this.emit('pool:org:discarded', {
        reason: 'Org has status "Deleted"',
        timestamp: new Date(),
        username: org.auth.username!,
      });
      this.logger?.warn(`Discarding org ${org.auth.username} — reported as deleted`);
      return null;
    } catch (error) {
      this.emit('pool:org:discarded', {
        reason: error instanceof Error ? error.message : String(error),
        timestamp: new Date(),
        username: org.auth.username!,
      });
      this.logger?.warn(`Unable to verify org ${org.auth.username}, discarding: ${error instanceof Error ? error.message : error}`);
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
  sizing: PoolSize,
): PoolAllocation {
  const toSatisfyMax = Math.max(0, sizing.max - currentActiveCount);

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
const noop = (): void => { };
const noopLogger: Logger = {
  debug: noop,
  error: noop,
  info: noop,
  trace: noop,
  warn: noop,
};
