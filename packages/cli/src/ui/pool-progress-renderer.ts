import type {
  PoolDeleteResult,
  PoolFetcher,
  PoolManager,
  PoolOrg,
  PoolProvisionResult,
} from '@b64hub/sfpm-orgs';

import {printTable} from '@oclif/table';
import chalk from 'chalk';
import {Listr} from 'listr2';

import type {
  EventConfig, EventLog, OutputLogger, OutputMode,
} from './renderer-utils.js';

import {infoBox, successBox} from './boxes.js';
import {formatDuration, sym, terminalLink} from './renderer-utils.js';

export type {OutputMode} from './renderer-utils.js';

// ============================================================================
// Pool Progress Renderer
// ============================================================================

interface PoolRendererOptions {
  logger: OutputLogger;
  mode: OutputMode;
}

interface Deferred {
  promise: Promise<void>;
  reject: (err: Error) => void;
  resolve: () => void;
}

/**
 * Lightweight listr2-based progress renderer for pool operations.
 *
 * Tracks summary counts (X/Y orgs created, Z/Y validated, tasks complete)
 * rather than individual spinners. Keeps the UI responsive when provisioning
 * 20+ orgs concurrently.
 *
 * Follows the event-driven UI pattern: attaches to PoolManager or
 * PoolFetcher event emitters and renders progress based on the
 * output mode (interactive, quiet, or JSON).
 */
export class PoolProgressRenderer {
  private createdCount = 0;
  private events: EventLog[] = [];
  private failedCount = 0;
  private listr?: Listr;
  private logger: OutputLogger;
  private mode: OutputMode;
  private provisionDeferred?: Deferred;
  private provisionResolved = false;
  private provisionTask?: any;
  private singleTaskDeferred?: Deferred;
  private singleTaskRef?: any;
  private taskExecutionDeferred?: Deferred;
  private taskExecutionResolved = false;
  private taskExecutionTask?: any;
  private taskProgress: Map<string, {completed: number; failed: number; started: number}> = new Map();
  private totalOrgs = 0;
  private validatedCount = 0;

  constructor(options: PoolRendererOptions) {
    this.logger = options.logger;
    this.mode = options.mode;
  }

  // --------------------------------------------------------------------------
  // Attach to emitters
  // --------------------------------------------------------------------------

  /**
   * Attach to a PoolFetcher to render fetch progress.
   */
  public attachToFetcher(fetcher: PoolFetcher): void {
    const configs: Record<string, EventConfig> = {
      'pool:fetch:claimed': {description: 'Org claimed', handler: this.handleFetchClaimed.bind(this)},
      'pool:fetch:complete': {description: 'Fetch complete', handler: this.handleFetchComplete.bind(this)},
      'pool:fetch:skipped': {description: 'Org skipped', handler: this.handleFetchSkipped.bind(this)},
      'pool:fetch:start': {description: 'Fetch started', handler: this.handleFetchStart.bind(this)},
    };

    for (const [event, config] of Object.entries(configs)) {
      fetcher.on(event as any, config.handler);
    }
  }

  /**
   * Attach to a PoolManager to render provision/delete progress.
   */
  public attachToManager(manager: PoolManager): void {
    const configs: Record<string, EventConfig> = {
      'pool:allocation:computed': {description: 'Allocation computed', handler: this.handleAllocationComputed.bind(this)},
      'pool:delete:complete': {description: 'Delete complete', handler: this.handleDeleteComplete.bind(this)},
      'pool:delete:start': {description: 'Delete started', handler: this.handleDeleteStart.bind(this)},
      'pool:org:created': {description: 'Org created', handler: this.handleOrgCreated.bind(this)},
      'pool:org:discarded': {description: 'Org discarded', handler: this.handleOrgDiscarded.bind(this)},
      'pool:org:failed': {description: 'Org failed', handler: this.handleOrgFailed.bind(this)},
      'pool:org:validated': {description: 'Org validated', handler: this.handleOrgValidated.bind(this)},
      'pool:provision:complete': {description: 'Provision complete', handler: this.handleProvisionComplete.bind(this)},
      'pool:provision:start': {description: 'Provision started', handler: this.handleProvisionStart.bind(this)},
      'pool:task:complete': {description: 'Task complete', handler: this.handleTaskComplete.bind(this)},
      'pool:task:error': {description: 'Task error', handler: this.handleTaskError.bind(this)},
      'pool:task:start': {description: 'Task started', handler: this.handleTaskStart.bind(this)},
    };

    for (const [event, config] of Object.entries(configs)) {
      manager.on(event as any, config.handler);
    }
  }

  /**
   * Return collected events for JSON output.
   */
  public getJsonOutput(): {events: EventLog[]} {
    return {events: this.events};
  }

  /**
   * Handle a terminal error.
   */
  public handleError(error: Error): void {
    this.singleTaskDeferred?.reject(error);
    this.singleTaskDeferred = undefined;
    this.provisionDeferred?.reject(error);
    this.taskExecutionDeferred?.reject(error);

    if (this.singleTaskRef) {
      this.singleTaskRef.title = `${sym.fail} ${error.message}`;
    }

    if (this.provisionTask) {
      this.provisionTask.title = `${sym.fail} ${error.message}`;
    }

    if (this.taskExecutionTask) {
      this.taskExecutionTask.title = `${sym.fail} ${error.message}`;
    }
  }

  // --------------------------------------------------------------------------
  // Provision event handlers
  // --------------------------------------------------------------------------

  /**
   * Render a fetched org summary box.
   */
  public renderFetchedOrg(org: PoolOrg, frontDoorUrl?: string): void {
    if (!this.isInteractive()) return;

    const loginUrl = frontDoorUrl ?? org.auth.loginUrl;
    const loginDisplay = loginUrl ? terminalLink('Open', loginUrl) : undefined;

    this.logger.log('');
    this.logger.log(successBox('Fetched Org', {
      ...(org.auth.alias ? {Alias: org.auth.alias} : {}),
      ...(org.expiry ? {Expires: formatExpiry(org.expiry)} : {}),
      ...(loginDisplay ? {'Login URL': loginDisplay} : {}),
      ...(org.orgId ? {'Org ID': org.orgId} : {}),
      ...(org.auth.password ? {Password: org.auth.password} : {}),
      Type: org.orgType ?? 'scratch',
      Username: org.auth.username ?? 'N/A',
    }));
  }

  /**
   * Render a list of orgs as a summary.
   */
  public renderOrgList(orgs: PoolOrg[], tag: string): void {
    if (!this.isInteractive()) return;

    if (orgs.length === 0) {
      this.logger.log(chalk.yellow(`No orgs found in pool "${tag}"`));
      return;
    }

    this.logger.log('\n');
    printTable({
      borderStyle: 'headers-only-with-underline',
      columns: [
        {key: 'tag', name: 'Tag'},
        {key: 'type', name: 'Type'},
        {key: 'username', name: 'Username'},
        {key: 'alias', name: 'Alias'},
        {key: 'status', name: 'Status'},
        {key: 'expiryDate', name: 'Expires'},
      ],
      data: orgs.map(org => ({
        alias: org.auth.alias ?? '',
        expiryDate: org.expiry ? formatExpiry(org.expiry) : '',
        loginURL: org.auth.loginUrl ?? '',
        status: formatStatus(org.pool?.status),
        tag: org.pool?.tag ?? '',
        type: org.orgType ?? '',
        username: org.auth.username ?? '',
      })),
    });
  }

  private buildTaskExecutionTitle(prefix: string): string {
    if (this.taskProgress.size === 0) {
      return `${prefix} (waiting for task events)`;
    }

    const parts = [...this.taskProgress.entries()]
    .map(([taskName, counts]) => {
      const base = `${taskName}: ${counts.completed}/${this.totalOrgs}`;
      if (counts.failed > 0) {
        return `${base}, ${counts.failed} failed`;
      }

      return base;
    })
    .join(' | ');

    return `${prefix} (${parts})`;
  }

  private handleAllocationComputed(payload: {currentAllocation: number; remaining: number; tag: string; toAllocate: number}): void {
    this.logEvent('pool:allocation:computed', payload);

    if (!this.isInteractive()) return;

    this.logger.log('');
    this.logger.log(infoBox('Pool Allocation', {
      Current: String(payload.currentAllocation),
      'DevHub Remaining': String(payload.remaining),
      Pool: payload.tag,
      'To Allocate': String(payload.toAllocate),
    }));
  }

  private handleDeleteComplete(payload: PoolDeleteResult): void {
    this.logEvent('pool:delete:complete', payload);
    this.singleTaskDeferred?.resolve();
    this.singleTaskDeferred = undefined;

    if (!this.isInteractive()) return;

    this.logger.log('');
    if (payload.deleted.length > 0) {
      this.logger.log(successBox('Pool Delete', {
        Deleted: String(payload.deleted.length),
        Duration: formatDuration(payload.elapsedMs),
        Errors: payload.errors.length > 0 ? String(payload.errors.length) : 'None',
        Pool: payload.tag,
      }));
    } else {
      this.logger.log(chalk.yellow('No orgs were deleted'));
    }
  }

  private handleDeleteStart(payload: {count: number; tag: string; timestamp: Date}): void {
    this.logEvent('pool:delete:start', payload);

    if (!this.isInteractive()) return;

    this.startSingleTaskListr(`Deleting ${payload.count} org(s) from pool "${payload.tag}"...`);
  }

  private handleFetchClaimed(payload: {tag: string; timestamp: Date; username: string}): void {
    this.logEvent('pool:fetch:claimed', payload);

    if (!this.isInteractive()) return;

    if (this.singleTaskRef) {
      this.singleTaskRef.title = `${sym.success} Claimed ${payload.username}`;
    }
  }

  private handleFetchComplete(payload: {count: number; tag: string; timestamp: Date}): void {
    this.logEvent('pool:fetch:complete', payload);
    this.singleTaskDeferred?.resolve();
    this.singleTaskDeferred = undefined;

    if (!this.isInteractive()) return;

    this.logger.log(`Fetched ${payload.count} org(s) from pool "${payload.tag}"`);
  }

  private handleFetchSkipped(payload: {reason: string; timestamp: Date; username: string}): void {
    this.logEvent('pool:fetch:skipped', payload);

    if (!this.isInteractive()) return;

    if (this.singleTaskRef) {
      this.singleTaskRef.title = `${sym.skip} Skipped ${payload.username}: ${payload.reason}`;
    }
  }

  private handleFetchStart(payload: {available: number; tag: string; timestamp: Date}): void {
    this.logEvent('pool:fetch:start', payload);

    if (!this.isInteractive()) return;

    this.startSingleTaskListr(`Searching pool "${payload.tag}" (${payload.available} available)...`);
  }

  private handleOrgCreated(payload: {alias: string; index: number; timestamp: Date; total: number}): void {
    this.logEvent('pool:org:created', payload);
    this.createdCount++;
    this.totalOrgs = payload.total;

    if (!this.isInteractive()) return;

    this.updateProvisioningStepTitle();
  }

  private handleOrgDiscarded(payload: {reason: string; timestamp: Date; username: string}): void {
    this.logEvent('pool:org:discarded', payload);
  }

  private handleOrgFailed(payload: {alias: string; error: string; index: number; timedOut: boolean; timestamp: Date}): void {
    this.logEvent('pool:org:failed', payload);
    this.failedCount++;

    if (!this.isInteractive()) return;

    const suffix = payload.timedOut ? ' (timed out)' : '';
    if (this.provisionTask && !this.provisionResolved) {
      this.provisionTask.title = chalk.red(`Org provisioning (${this.createdCount}/${this.totalOrgs} created, ${this.validatedCount}/${this.totalOrgs} validated, ${this.failedCount} failed) - ${payload.alias}${suffix}`);
    }

    this.updateProvisioningStepTitle();
  }

  private handleOrgValidated(payload: {timestamp: Date; username: string}): void {
    this.logEvent('pool:org:validated', payload);
    this.validatedCount++;

    if (!this.isInteractive()) return;

    this.updateProvisioningStepTitle();
    this.maybeResolveProvisioningStep();
  }

  private handleProvisionComplete(payload: PoolProvisionResult): void {
    this.logEvent('pool:provision:complete', payload);

    if (!this.isInteractive()) return;

    this.maybeResolveProvisioningStep(true);

    if (!this.taskExecutionResolved && this.taskExecutionTask) {
      if (this.taskProgress.size === 0) {
        this.taskExecutionTask.title = chalk.yellow('Executing pool tasks (skipped)');
      } else {
        this.taskExecutionTask.title = chalk.green(this.buildTaskExecutionTitle('Executed pool tasks'));
      }

      this.taskExecutionDeferred?.resolve();
      this.taskExecutionResolved = true;
    }

    // Show summary box
    this.logger.log('');
    this.logger.log(successBox('Pool Provision', {
      Duration: formatDuration(payload.elapsedMs),
      Errors: payload.errors.length > 0 ? String(payload.errors.length) : 'None',
      Failed: String(payload.failed),
      Pool: payload.tag,
      Succeeded: String(payload.succeeded.length),
    }));
  }

  private handleProvisionStart(payload: {tag: string; timestamp: Date; toAllocate: number}): void {
    this.logEvent('pool:provision:start', payload);
    this.totalOrgs = payload.toAllocate;
    this.createdCount = 0;
    this.validatedCount = 0;
    this.failedCount = 0;
    this.provisionResolved = false;
    this.taskExecutionResolved = false;
    this.taskProgress.clear();

    if (!this.isInteractive()) return;

    this.startProvisioningListr();
    this.updateProvisioningStepTitle();
  }

  private handleTaskComplete(payload: {success: boolean; task: string; timestamp: Date; username: string}): void {
    this.logEvent('pool:task:complete', payload);

    if (!this.isInteractive()) return;

    const counts = this.taskProgress.get(payload.task) ?? {completed: 0, failed: 0, started: 0};
    counts.completed++;
    if (!payload.success) {
      counts.failed++;
    }

    this.taskProgress.set(payload.task, counts);

    this.updateTaskExecutionTitle();
  }

  private handleTaskError(payload: {error: string; task: string; timestamp: Date; username: string}): void {
    this.logEvent('pool:task:error', payload);

    if (!this.isInteractive()) return;

    const counts = this.taskProgress.get(payload.task) ?? {completed: 0, failed: 0, started: 0};
    if (counts.failed === 0) {
      counts.failed = 1;
    }

    this.taskProgress.set(payload.task, counts);

    if (this.taskExecutionTask && !this.taskExecutionResolved) {
      this.taskExecutionTask.title = chalk.red(`${this.buildTaskExecutionTitle('Executing pool tasks')} - ${payload.task} failed on ${payload.username}`);
    }
  }

  // --------------------------------------------------------------------------
  // Helpers
  // --------------------------------------------------------------------------

  private handleTaskStart(payload: {task: string; timestamp: Date; username: string}): void {
    this.logEvent('pool:task:start', payload);

    if (!this.isInteractive()) return;

    const counts = this.taskProgress.get(payload.task) ?? {completed: 0, failed: 0, started: 0};
    counts.started++;
    this.taskProgress.set(payload.task, counts);

    this.updateTaskExecutionTitle();
  }

  private isInteractive(): boolean {
    return this.mode === 'interactive';
  }

  private logEvent(type: string, data: unknown): void {
    this.events.push({
      data,
      timestamp: new Date(),
      type,
    });
  }

  private maybeResolveProvisioningStep(force = false): void {
    if (this.provisionResolved || !this.provisionTask) return;

    const done = this.totalOrgs > 0 && (this.validatedCount + this.failedCount) >= this.totalOrgs;
    if (!force && !done) return;

    if (this.failedCount > 0) {
      this.provisionTask.title = chalk.yellow(`Org provisioned (${this.validatedCount}/${this.totalOrgs} ready, ${this.failedCount} failed)`);
    } else {
      this.provisionTask.title = chalk.green(`Org provisioned (${this.validatedCount}/${this.totalOrgs} ready)`);
    }

    this.provisionDeferred?.resolve();
    this.provisionResolved = true;
  }

  private startProvisioningListr(): void {
    this.provisionDeferred = createDeferred();
    this.taskExecutionDeferred = createDeferred();

    this.listr = new Listr([
      {
        task: async (_ctx, task): Promise<void> => {
          this.provisionTask = task;
          task.title = `Org provisioning (0/${this.totalOrgs} created, 0/${this.totalOrgs} validated)`;
          await this.provisionDeferred!.promise;
        },
        title: `Org provisioning (0/${this.totalOrgs} created, 0/${this.totalOrgs} validated)`,
      },
      {
        task: async (_ctx, task): Promise<void> => {
          this.taskExecutionTask = task;
          task.title = 'Executing pool tasks (waiting for task events)';
          await this.taskExecutionDeferred!.promise;
        },
        title: 'Executing pool tasks',
      },
    ], {
      concurrent: true,
      rendererOptions: {showErrorMessage: true},
    });

    this.listr.run().catch(() => {
      // Errors are reflected by event handlers
    });
  }

  private startSingleTaskListr(initialTitle: string): void {
    this.singleTaskDeferred = createDeferred();
    this.listr = new Listr([
      {
        task: async (_ctx, task): Promise<void> => {
          this.singleTaskRef = task;
          task.title = initialTitle;
          await this.singleTaskDeferred!.promise;
        },
        title: initialTitle,
      },
    ], {
      rendererOptions: {showErrorMessage: true},
    });

    this.listr.run().catch(() => {
      // Errors are reflected by event handlers
    });
  }

  private updateProvisioningStepTitle(): void {
    if (!this.provisionTask || this.provisionResolved) return;

    const details = `${this.createdCount}/${this.totalOrgs} created, ${this.validatedCount}/${this.totalOrgs} validated`;
    if (this.failedCount > 0) {
      this.provisionTask.title = `Org provisioning (${details}, ${this.failedCount} failed)`;
      return;
    }

    this.provisionTask.title = `Org provisioning (${details})`;
  }

  private updateTaskExecutionTitle(): void {
    if (!this.taskExecutionTask || this.taskExecutionResolved) return;
    this.taskExecutionTask.title = this.buildTaskExecutionTitle('Executing pool tasks');
  }
}

// ============================================================================
// Helpers
// ============================================================================

function formatExpiry(expiry: number): string {
  const expiryDate = new Date(expiry);
  const now = new Date();
  const diffMs = expiryDate.getTime() - now.getTime();
  const daysLeft = Math.ceil(diffMs / (1000 * 60 * 60 * 24));
  const dateStr = expiryDate.toISOString().split('T')[0];

  if (daysLeft <= 0) return chalk.red(`Expired ${chalk.dim(dateStr)}`);
  return `${daysLeft}d ${chalk.dim(dateStr)}`;
}

function formatStatus(status?: string): string {
  switch (status) {
  case 'Allocate': {return chalk.blue('Allocate   ');
  }

  case 'Assigned': {return chalk.cyan('Assigned   ');
  }

  case 'Available': {return chalk.green('Available  ');
  }

  case 'In_Progress': {return chalk.yellow('In Progress');
  }

  case 'Return': {return chalk.magenta('Return     ');
  }

  default: {return chalk.dim((status ?? 'Unknown').padEnd(11));
  }
  }
}

function createDeferred(): Deferred {
  let resolve!: () => void;
  let reject!: (err: Error) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return {promise, reject, resolve};
}
