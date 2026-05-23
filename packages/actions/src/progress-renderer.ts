import type {Logger} from '@b64hub/sfpm-core';
import type {EventEmitter} from 'node:events';

import * as core from '@actions/core';

import type {BufferEntry} from './logger.js';

import {GitHubActionsLogger} from './logger.js';

// ============================================================================
// Types
// ============================================================================

interface EventRecord {
  data: Record<string, unknown>;
  timestamp: Date;
  type: string;
}

interface PackageRecord {
  duration?: number;
  error?: string;
  name: string;
  skipped: boolean;
  success: boolean;
}

// ============================================================================
// ActionsProgressRenderer
// ============================================================================

/**
 * Event-driven progress renderer for GitHub Actions.
 *
 * Subscribes to core service events (install, deployment, pool, etc.)
 * and renders them as GitHub Actions log groups with structured output.
 * Unlike the CLI renderer (spinners, boxes), this produces plain text
 * output suitable for the Actions log viewer.
 *
 * For orchestrated (build/install) operations, events are buffered per-package
 * and flushed atomically as collapsible groups on completion. This prevents
 * concurrent package output from interleaving inside each other's groups.
 *
 * @example
 * ```typescript
 * const logger = createGitHubActionsLogger();
 * const renderer = new ActionsProgressRenderer(logger);
 * renderer.attachToBuildOrchestrator(orchestrator);
 * await orchestrator.buildAll(packages);
 * renderer.printSummary();
 * ```
 */
export class ActionsProgressRenderer {
  private readonly events: EventRecord[] = [];
  private readonly logger: GitHubActionsLogger;
  private readonly packages: PackageRecord[] = [];
  private startTime?: Date;

  constructor(logger: GitHubActionsLogger) {
    this.logger = logger;
  }

  // --------------------------------------------------------------------------
  // Attach to emitters
  // --------------------------------------------------------------------------

  /**
   * Attach to a build orchestrator to render build progress.
   */
  public attachToBuildOrchestrator(emitter: EventEmitter): void {
    emitter.on('orchestration:start', (data: any) => {
      this.startTime = new Date();
      this.recordEvent('orchestration:start', data);
      this.logger.info(`Starting build of ${data.totalPackages} package(s)`);
    });

    emitter.on('orchestration:level:start', (data: any) => {
      this.recordEvent('orchestration:level:start', data);
      const names: string[] = data.packages ?? [];
      this.logger.info(`Level ${data.level}: ${names.join(', ')}`);
    });

    emitter.on('build:start', (data: any) => {
      this.recordEvent('build:start', data);
      this.bufferMessage(data.packageName, 'info', `Building: ${data.packageName} (${data.packageType ?? 'unknown'})`);
    });

    emitter.on('build:complete', (data: any) => {
      this.recordEvent('build:complete', data);
      this.bufferMessage(data.packageName, 'info', `Built: ${data.packageName} v${data.version ?? '?'}`);
    });

    emitter.on('build:skipped', (data: any) => {
      this.recordEvent('build:skipped', data);
      this.bufferMessage(data.packageName, 'info', `Skipped: ${data.packageName} (${data.reason ?? 'no changes'})`);
    });

    emitter.on('build:error', (data: any) => {
      this.recordEvent('build:error', data);
      this.bufferMessage(data.packageName, 'error', `Failed: ${data.packageName} — ${data.error ?? 'unknown error'}`);
    });

    emitter.on('stage:start', (data: any) => {
      this.recordEvent('stage:start', data);
      this.bufferMessage(data.packageName, 'debug', 'Staging package...');
    });

    emitter.on('stage:complete', (data: any) => {
      this.recordEvent('stage:complete', data);
      this.bufferMessage(data.packageName, 'debug', `Staged (${data.componentCount ?? '?'} components)`);
    });

    emitter.on('connection:start', (data: any) => {
      this.recordEvent('connection:start', data);
      this.bufferMessage(data.packageName, 'debug', `Connecting to ${data.username}...`);
    });

    emitter.on('connection:complete', (data: any) => {
      this.recordEvent('connection:complete', data);
      this.bufferMessage(data.packageName, 'debug', 'Connected to DevHub');
    });

    emitter.on('unlocked:create:start', (data: any) => {
      this.recordEvent('unlocked:create:start', data);
      this.bufferMessage(data.packageName, 'info', `Creating package version for ${data.packageName}...`);
    });

    emitter.on('unlocked:create:progress', (data: any) => {
      this.recordEvent('unlocked:create:progress', data);
      if (data.status) {
        this.bufferMessage(data.packageName, 'debug', `Package creation status: ${data.status}`);
      }
    });

    emitter.on('unlocked:create:complete', (data: any) => {
      this.recordEvent('unlocked:create:complete', data);
      this.bufferMessage(data.packageName, 'info', `Package version created: ${data.packageVersionId ?? ''} (${data.versionNumber ?? ''})`);
    });

    emitter.on('assembly:start', (data: any) => {
      this.recordEvent('assembly:start', data);
      this.bufferMessage(data.packageName, 'debug', 'Assembling artifact...');
    });

    emitter.on('assembly:complete', (data: any) => {
      this.recordEvent('assembly:complete', data);
      this.bufferMessage(data.packageName, 'info', `Artifact assembled: ${data.artifactPath ?? ''}`);
    });

    emitter.on('task:start', (data: any) => {
      this.recordEvent('task:start', data);
      this.bufferMessage(data.packageName, 'debug', `Running task: ${data.taskName ?? data.task ?? 'unknown'}`);
    });

    emitter.on('task:complete', (data: any) => {
      this.recordEvent('task:complete', data);
      this.bufferMessage(data.packageName, 'debug', `Task complete: ${data.taskName ?? data.task ?? 'unknown'}`);
    });

    emitter.on('orchestration:package:complete', (data: any) => {
      this.recordEvent('orchestration:package:complete', data);
      this.flushPackageGroup('Build', data);
    });

    emitter.on('orchestration:complete', (data: any) => {
      this.recordEvent('orchestration:complete', data);
    });
  }

  /**
   * Attach to an install orchestrator to render install progress.
   */
  public attachToInstaller(emitter: EventEmitter): void {
    emitter.on('orchestration:start', (data: any) => {
      this.startTime = new Date();
      this.recordEvent('orchestration:start', data);
      this.logger.info(`Starting installation of ${data.totalPackages} package(s)`);
    });

    emitter.on('orchestration:level:start', (data: any) => {
      this.recordEvent('orchestration:level:start', data);
      const names: string[] = data.packages ?? [];
      this.logger.info(`Level ${data.level}: ${names.join(', ')}`);
    });

    emitter.on('orchestration:package:start', (data: any) => {
      this.recordEvent('orchestration:package:start', data);
      // No immediate output — buffered via child logger and event handlers
    });

    emitter.on('install:start', (data: any) => {
      this.recordEvent('install:start', data);
      this.bufferMessage(data.packageName, 'info', `Package: ${data.packageName} (${data.packageType ?? 'unknown'})`);
    });

    emitter.on('connection:start', (data: any) => {
      this.recordEvent('connection:start', data);
      this.bufferMessage(data.packageName, 'debug', `Connecting to ${data.username}...`);
    });

    emitter.on('connection:complete', (data: any) => {
      this.recordEvent('connection:complete', data);
      this.bufferMessage(data.packageName, 'debug', `Connected to org ${data.orgId ?? data.username}`);
    });

    emitter.on('deployment:start', (data: any) => {
      this.recordEvent('deployment:start', data);
      this.bufferMessage(data.packageName, 'info', 'Source deployment started');
    });

    emitter.on('deployment:progress', (data: any) => {
      this.recordEvent('deployment:progress', data);
      if (data.status) {
        this.bufferMessage(data.packageName, 'debug', `Deployment status: ${data.status}`);
      }
    });

    emitter.on('deployment:complete', (data: any) => {
      this.recordEvent('deployment:complete', data);
      this.bufferMessage(data.packageName, 'info', `Deployment complete (${data.componentCount ?? '?'} components)`);
    });

    emitter.on('version-install:start', (data: any) => {
      this.recordEvent('version-install:start', data);
      this.bufferMessage(data.packageName, 'info', `Installing package version ${data.packageVersionId ?? ''}`);
    });

    emitter.on('version-install:progress', (data: any) => {
      this.recordEvent('version-install:progress', data);
      if (data.status) {
        this.bufferMessage(data.packageName, 'debug', `Version install status: ${data.status}`);
      }
    });

    emitter.on('version-install:complete', (data: any) => {
      this.recordEvent('version-install:complete', data);
      this.bufferMessage(data.packageName, 'info', 'Version install complete');
    });

    emitter.on('install:skip', (data: any) => {
      this.recordEvent('install:skip', data);
      this.bufferMessage(data.packageName, 'info', `Skipped: ${data.packageName} (${data.reason ?? 'already installed'})`);
    });

    emitter.on('install:complete', (data: any) => {
      this.recordEvent('install:complete', data);
      this.bufferMessage(data.packageName, 'info', `Installed: ${data.packageName} v${data.version ?? '?'}`);
    });

    emitter.on('install:error', (data: any) => {
      this.recordEvent('install:error', data);
      this.bufferMessage(data.packageName, 'error', `Failed: ${data.packageName} — ${data.error ?? 'unknown error'}`);
    });

    emitter.on('orchestration:package:complete', (data: any) => {
      this.recordEvent('orchestration:package:complete', data);
      this.flushPackageGroup('Install', data);
    });

    emitter.on('orchestration:complete', (data: any) => {
      this.recordEvent('orchestration:complete', data);
    });
  }

  /**
   * Attach to a pool manager to render provisioning progress.
   * Pool operations are not buffered — they write immediately.
   */
  public attachToManager(emitter: EventEmitter): void {
    emitter.on('pool:provision:start', (data: any) => {
      this.startTime = new Date();
      this.recordEvent('pool:provision:start', data);
      this.logger.group(`Provisioning pool "${data.tag}"`);
      this.logger.info(`Provisioning ${data.toAllocate} org(s) for pool "${data.tag}"`);
    });

    emitter.on('pool:allocation:computed', (data: any) => {
      this.recordEvent('pool:allocation:computed', data);
      this.logger.info(`Allocation: ${data.toAllocate} to create (${data.currentAllocation} current, ${data.remaining} remaining on DevHub)`);
    });

    emitter.on('pool:org:created', (data: any) => {
      this.recordEvent('pool:org:created', data);
      this.logger.info(`Created org ${data.alias} (${data.index + 1}/${data.total})`);
    });

    emitter.on('pool:org:failed', (data: any) => {
      this.recordEvent('pool:org:failed', data);
      const suffix = data.timedOut ? ' (timed out)' : '';
      this.logger.error(`Failed ${data.alias}: ${data.error}${suffix}`);
    });

    emitter.on('pool:org:validated', (data: any) => {
      this.recordEvent('pool:org:validated', data);
      this.logger.debug(`Validated org ${data.username}`);
    });

    emitter.on('pool:org:discarded', (data: any) => {
      this.recordEvent('pool:org:discarded', data);
      this.logger.warn(`Discarded ${data.username}: ${data.reason}`);
    });

    emitter.on('pool:task:start', (data: any) => {
      this.recordEvent('pool:task:start', data);
      this.logger.info(`Running ${data.task} on ${data.username}`);
    });

    emitter.on('pool:task:complete', (data: any) => {
      this.recordEvent('pool:task:complete', data);
      if (data.success) {
        this.logger.info(`${data.task} completed for ${data.username}`);
      } else {
        this.logger.error(`${data.task} failed for ${data.username}`);
      }
    });

    emitter.on('pool:task:error', (data: any) => {
      this.recordEvent('pool:task:error', data);
      this.logger.error(`${data.task} error on ${data.username}: ${data.error}`);
    });

    emitter.on('pool:provision:complete', (data: any) => {
      this.recordEvent('pool:provision:complete', data);
      this.logger.info(`Provisioning complete: ${data.succeeded?.length ?? 0} succeeded, ${data.failed ?? 0} failed`);
      this.logger.groupEnd();
    });
  }

  /**
   * Attach to a pool fetcher to render pool fetch progress.
   */
  public attachToPoolFetcher(emitter: EventEmitter): void {
    emitter.on('pool:fetch:start', (data: any) => {
      this.recordEvent('pool:fetch:start', data);
      this.logger.info(`Pool "${data.tag}": ${data.available} org(s) available`);
    });

    emitter.on('pool:fetch:claimed', (data: any) => {
      this.recordEvent('pool:fetch:claimed', data);
      this.logger.info(`Claimed org: ${data.username}`);
    });

    emitter.on('pool:fetch:skipped', (data: any) => {
      this.recordEvent('pool:fetch:skipped', data);
      this.logger.debug(`Skipped org ${data.username}: ${data.reason}`);
    });

    emitter.on('pool:fetch:complete', (data: any) => {
      this.recordEvent('pool:fetch:complete', data);
      this.logger.info(`Pool fetch complete (${data.count} org(s))`);
    });
  }

  // --------------------------------------------------------------------------
  // Summary
  // --------------------------------------------------------------------------

  /**
   * Return collected events as a JSON-serializable array.
   */
  public getEventLog(): EventRecord[] {
    return [...this.events];
  }

  /**
   * Print an enhanced summary table of all packages.
   */
  public printSummary(): void {
    const totalDuration = this.startTime
      ? Math.round((Date.now() - this.startTime.getTime()) / 1000)
      : undefined;

    this.logger.group(totalDuration === undefined ? 'Summary' : `Summary (${totalDuration}s)`);

    if (this.packages.length > 0) {
      for (const pkg of this.packages) {
        const durationStr = pkg.duration === undefined ? '' : `${Math.round(pkg.duration / 1000)}s`;
        if (pkg.skipped) {
          this.logger.info(`  \u2298 ${pkg.name}  ${durationStr ? `${durationStr}  ` : ''}\u2014 skipped${pkg.error ? ` (${pkg.error})` : ''}`);
        } else if (pkg.success) {
          this.logger.info(`  \u2713 ${pkg.name}  ${durationStr}`);
        } else {
          this.logger.info(`  \u2717 ${pkg.name}  ${durationStr}  \u2014 ${pkg.error ?? 'unknown error'}`);
        }
      }
    } else {
      this.logger.info(`Total events: ${this.events.length}`);
    }

    if (totalDuration !== undefined) {
      this.logger.info(`Total duration: ${totalDuration}s`);
    }

    this.logger.groupEnd();
  }

  // --------------------------------------------------------------------------
  // Private — Buffering
  // --------------------------------------------------------------------------

  /**
   * Write a message to the child buffer for the given package.
   * If no child buffer exists yet, creates one via the logger.
   */
  private bufferMessage(packageName: string | undefined, level: BufferEntry['level'], message: string): void {
    if (!packageName) {
      // Fallback: write immediately if no package context
      this.writeEntry({level, message});
      return;
    }

    // Ensure a child buffer exists
    if (!this.logger.hasChildBuffer(packageName)) {
      this.logger.child({package: packageName});
    }

    const buffer = this.logger.getChildBuffer(packageName);
    buffer.push({level, message});
  }

  /**
   * Flush a package's buffered output as a collapsible group.
   * Called on `orchestration:package:complete`.
   */
  private flushPackageGroup(prefix: string, data: any): void {
    const {packageName} = data;
    const success: boolean = data.success !== false;
    const skipped: boolean = data.skipped === true;
    const {duration} = data;
    const durationStr = duration === undefined ? '' : ` (${Math.round(duration / 1000)}s)`;

    // Track for summary
    this.packages.push({
      duration,
      error: data.error,
      name: packageName,
      skipped,
      success,
    });

    // Skipped packages get a one-liner, no group
    if (skipped) {
      const reason = data.error ?? 'no changes';
      this.logger.info(`\u2298 ${prefix}: ${packageName} (skipped \u2014 ${reason})`);
      this.logger.clearChildBuffer(packageName);
      return;
    }

    // Build group label with outcome
    const icon = success ? '\u2713' : '\u2717';
    const label = `${prefix}: ${packageName} ${icon}${durationStr}`;

    // Flush buffer entries into a group
    const entries = this.logger.getChildBuffer(packageName);
    this.logger.group(label);
    for (const entry of entries) {
      this.writeEntry(entry);
    }

    this.logger.groupEnd();
    this.logger.clearChildBuffer(packageName);
  }

  private recordEvent(type: string, data: Record<string, unknown>): void {
    this.events.push({data, timestamp: new Date(), type});
  }

  /** Write a single buffer entry to output using the appropriate Actions command. */
  private writeEntry(entry: BufferEntry): void {
    switch (entry.level) {
    case 'debug': {
      core.debug(entry.message);
      break;
    }

    case 'error': {
      core.error(entry.message);
      break;
    }

    case 'trace': {
      core.debug(`[trace] ${entry.message}`);
      break;
    }

    case 'warn': {
      core.warning(entry.message);
      break;
    }

    default: {
      core.info(entry.message);
      break;
    }
    }
  }
}
