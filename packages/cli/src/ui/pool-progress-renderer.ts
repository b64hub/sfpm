import type {
  PoolDeleteResult,
  PoolFetcher,
  PoolManager,
  PoolOrg,
  PoolProvisionResult,
} from '@b64/sfpm-orgs';

import chalk from 'chalk';
import ora, {type Ora} from 'ora';

import type {
  EventConfig, EventLog, OutputLogger, OutputMode,
} from './renderer-utils.js';

import {infoBox, successBox} from './boxes.js';
import {formatDuration} from './renderer-utils.js';

export type {OutputMode} from './renderer-utils.js';

// ============================================================================
// Pool Progress Renderer
// ============================================================================

interface PoolRendererOptions {
  logger: OutputLogger;
  mode: OutputMode;
}

/**
 * Renders pool operation progress in different output modes.
 *
 * Follows the event-driven UI pattern: attaches to PoolManager or
 * PoolFetcher event emitters and renders progress based on the
 * output mode (interactive, quiet, or JSON).
 */
export class PoolProgressRenderer {
  private currentOrg = 0;
  private events: EventLog[] = [];
  private logger: OutputLogger;
  private mode: OutputMode;
  private spinner?: Ora;
  private totalOrgs = 0;

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
      'pool:org:deleted': {description: 'Org deleted', handler: this.handleOrgDeleted.bind(this)},
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
    this.spinner?.fail(chalk.red(error.message));
  }

  // --------------------------------------------------------------------------
  // Provision event handlers
  // --------------------------------------------------------------------------

  /**
   * Render a fetched org summary box.
   */
  public renderFetchedOrg(org: PoolOrg): void {
    if (!this.isInteractive()) return;

    this.logger.log('');
    this.logger.log(successBox('Scratch Org', {
      ...(org.auth.alias ? {Alias: org.auth.alias} : {}),
      ...(org.auth.loginUrl ? {'Login URL': org.auth.loginUrl} : {}),
      ...(org.auth.password ? {Password: org.auth.password} : {}),
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

    this.logger.log(`\nFound ${orgs.length} org(s) in pool "${tag}":\n`);

    for (const org of orgs) {
      const status = formatStatus(org.pool?.status);
      const expiry = org.expiry ? chalk.dim(` (expires ${new Date(org.expiry).toISOString().split('T')[0]})`) : '';
      this.logger.log(`  ${status} ${chalk.white(org.auth.username ?? 'N/A')}${expiry}`);
    }

    this.logger.log('');
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
    this.spinner?.stop();

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

    this.spinner = ora(`Deleting ${payload.count} org(s) from pool "${payload.tag}"...`).start();
  }

  private handleFetchClaimed(payload: {tag: string; timestamp: Date; username: string}): void {
    this.logEvent('pool:fetch:claimed', payload);

    if (!this.isInteractive()) return;

    this.spinner?.succeed(chalk.green(`Claimed ${payload.username}`));
  }

  private handleFetchComplete(payload: {count: number; tag: string; timestamp: Date}): void {
    this.logEvent('pool:fetch:complete', payload);
    this.spinner?.stop();

    if (!this.isInteractive()) return;

    this.logger.log(`Fetched ${payload.count} org(s) from pool "${payload.tag}"`);
  }

  private handleFetchSkipped(payload: {reason: string; timestamp: Date; username: string}): void {
    this.logEvent('pool:fetch:skipped', payload);

    if (!this.isInteractive()) return;

    this.spinner?.warn(chalk.yellow(`Skipped ${payload.username}: ${payload.reason}`));
    this.spinner = ora('Searching for available org...').start();
  }

  private handleFetchStart(payload: {available: number; tag: string; timestamp: Date}): void {
    this.logEvent('pool:fetch:start', payload);

    if (!this.isInteractive()) return;

    this.spinner = ora(`Searching pool "${payload.tag}" (${payload.available} available)...`).start();
  }

  private handleOrgCreated(payload: {alias: string; index: number; timestamp: Date; total: number}): void {
    this.logEvent('pool:org:created', payload);
    this.currentOrg = payload.index + 1;
    this.totalOrgs = payload.total;

    if (!this.isInteractive()) return;

    this.spinner?.succeed(chalk.green(`Created ${payload.alias}`));
    if (this.currentOrg < this.totalOrgs) {
      this.spinner = ora(`Creating orgs (${this.currentOrg}/${this.totalOrgs})...`).start();
    }
  }

  // --------------------------------------------------------------------------
  // Task event handlers
  // --------------------------------------------------------------------------

  private handleOrgDeleted(payload: {timestamp: Date; username: string}): void {
    this.logEvent('pool:org:deleted', payload);

    if (!this.isInteractive()) return;

    this.spinner?.succeed(chalk.green(`Deleted ${payload.username}`));
    this.spinner = ora('Deleting...').start();
  }

  private handleOrgDiscarded(payload: {reason: string; timestamp: Date; username: string}): void {
    this.logEvent('pool:org:discarded', payload);

    if (!this.isInteractive()) return;

    this.spinner?.warn(chalk.yellow(`Discarded ${payload.username}: ${payload.reason}`));
    this.spinner = ora('Processing...').start();
  }

  private handleOrgFailed(payload: {alias: string; error: string; index: number; timedOut: boolean; timestamp: Date}): void {
    this.logEvent('pool:org:failed', payload);

    if (!this.isInteractive()) return;

    const suffix = payload.timedOut ? ' (timed out)' : '';
    this.spinner?.fail(chalk.red(`Failed ${payload.alias}: ${payload.error}${suffix}`));
    this.spinner = ora(`Creating orgs (${payload.index + 1}/${this.totalOrgs})...`).start();
  }

  // --------------------------------------------------------------------------
  // Fetch event handlers
  // --------------------------------------------------------------------------

  private handleOrgValidated(payload: {timestamp: Date; username: string}): void {
    this.logEvent('pool:org:validated', payload);
  }

  private handleProvisionComplete(payload: PoolProvisionResult): void {
    this.logEvent('pool:provision:complete', payload);
    this.spinner?.stop();

    if (!this.isInteractive()) return;

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
    this.currentOrg = 0;

    if (!this.isInteractive()) return;

    this.spinner = ora(`Provisioning ${payload.toAllocate} org(s) for pool "${payload.tag}"...`).start();
  }

  private handleTaskComplete(payload: {success: boolean; task: string; timestamp: Date; username: string}): void {
    this.logEvent('pool:task:complete', payload);

    if (!this.isInteractive()) return;

    if (payload.success) {
      this.spinner?.succeed(chalk.green(`${payload.task} completed for ${payload.username}`));
    } else {
      this.spinner?.fail(chalk.red(`${payload.task} failed for ${payload.username}`));
    }
  }

  // --------------------------------------------------------------------------
  // Helpers
  // --------------------------------------------------------------------------

  private handleTaskError(payload: {error: string; task: string; timestamp: Date; username: string}): void {
    this.logEvent('pool:task:error', payload);

    if (!this.isInteractive()) return;

    this.spinner?.fail(chalk.red(`${payload.task} error on ${payload.username}: ${payload.error}`));
  }

  private handleTaskStart(payload: {task: string; timestamp: Date; username: string}): void {
    this.logEvent('pool:task:start', payload);

    if (!this.isInteractive()) return;

    this.spinner = ora(`Running ${payload.task} on ${payload.username}...`).start();
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
}

// ============================================================================
// Helpers
// ============================================================================

function formatStatus(status?: string): string {
  switch (status) {
  case 'Allocate': {return chalk.blue('Allocate   ');
  }

  case 'Assigned': {return chalk.cyan('Assigned   ');
  }

  case 'Available': {return chalk.green('Available  ');
  }

  case 'In Progress': {return chalk.yellow('In Progress');
  }

  case 'Return': {return chalk.magenta('Return     ');
  }

  default: {return chalk.dim((status ?? 'Unknown').padEnd(11));
  }
  }
}
