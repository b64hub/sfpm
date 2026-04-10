import type {Logger} from '@b64/sfpm-core';
import type {EventEmitter} from 'node:events';

import {isStructuredLogger} from '@b64/sfpm-core';

// ============================================================================
// Types
// ============================================================================

interface EventRecord {
  data: Record<string, unknown>;
  timestamp: Date;
  type: string;
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
 * Collects all events for a summary output at the end.
 *
 * @example
 * ```typescript
 * const renderer = new ActionsProgressRenderer(logger);
 * renderer.attachToInstaller(orchestrator);
 * await orchestrator.installAll(packages);
 * renderer.printSummary();
 * ```
 */
export class ActionsProgressRenderer {
  private currentPackage?: string;
  private readonly events: EventRecord[] = [];
  private readonly logger: Logger;
  private startTime?: Date;

  constructor(logger: Logger) {
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

    emitter.on('orchestration:package:complete', (data: any) => {
      this.recordEvent('orchestration:package:complete', data);
      if (isStructuredLogger(this.logger)) {
        this.logger.groupEnd();
      }

      this.currentPackage = undefined;
    });

    emitter.on('build:start', (data: any) => {
      this.currentPackage = data.packageName;
      this.recordEvent('build:start', data);
      if (isStructuredLogger(this.logger)) {
        this.logger.group(`Build: ${data.packageName} (${data.packageType ?? 'unknown'})`);
      } else {
        this.logger.info(`--- Building: ${data.packageName} ---`);
      }
    });

    emitter.on('build:complete', (data: any) => {
      this.recordEvent('build:complete', data);
      this.logger.info(`Built: ${data.packageName} v${data.version ?? '?'}`);
    });

    emitter.on('build:skipped', (data: any) => {
      this.recordEvent('build:skipped', data);
      this.logger.info(`Skipped: ${data.packageName} (${data.reason ?? 'no changes'})`);
    });

    emitter.on('build:error', (data: any) => {
      this.recordEvent('build:error', data);
      this.logger.error(`Failed: ${data.packageName} — ${data.error ?? 'unknown error'}`);
    });

    emitter.on('stage:start', (data: any) => {
      this.recordEvent('stage:start', data);
      this.logger.debug('Staging package...');
    });

    emitter.on('stage:complete', (data: any) => {
      this.recordEvent('stage:complete', data);
      this.logger.debug(`Staged (${data.componentCount ?? '?'} components)`);
    });

    emitter.on('connection:start', (data: any) => {
      this.recordEvent('connection:start', data);
      this.logger.debug(`Connecting to ${data.username}...`);
    });

    emitter.on('connection:complete', (data: any) => {
      this.recordEvent('connection:complete', data);
      this.logger.debug('Connected to DevHub');
    });

    emitter.on('unlocked:create:start', (data: any) => {
      this.recordEvent('unlocked:create:start', data);
      this.logger.info(`Creating package version for ${data.packageName}...`);
    });

    emitter.on('unlocked:create:progress', (data: any) => {
      this.recordEvent('unlocked:create:progress', data);
      if (data.status) {
        this.logger.debug(`Package creation status: ${data.status}`);
      }
    });

    emitter.on('unlocked:create:complete', (data: any) => {
      this.recordEvent('unlocked:create:complete', data);
      this.logger.info(`Package version created: ${data.packageVersionId ?? ''} (${data.versionNumber ?? ''})`);
    });

    emitter.on('assembly:start', (data: any) => {
      this.recordEvent('assembly:start', data);
      this.logger.debug('Assembling artifact...');
    });

    emitter.on('assembly:complete', (data: any) => {
      this.recordEvent('assembly:complete', data);
      this.logger.info(`Artifact assembled: ${data.artifactPath ?? ''}`);
    });

    emitter.on('task:start', (data: any) => {
      this.recordEvent('task:start', data);
      this.logger.debug(`Running task: ${data.taskName ?? data.task ?? 'unknown'}`);
    });

    emitter.on('task:complete', (data: any) => {
      this.recordEvent('task:complete', data);
      this.logger.debug(`Task complete: ${data.taskName ?? data.task ?? 'unknown'}`);
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

    emitter.on('orchestration:package:start', (data: any) => {
      this.currentPackage = data.packageName;
      this.recordEvent('orchestration:package:start', data);
      if (isStructuredLogger(this.logger)) {
        this.logger.group(`Install: ${data.packageName}`);
      } else {
        this.logger.info(`--- Installing: ${data.packageName} ---`);
      }
    });

    emitter.on('install:start', (data: any) => {
      this.recordEvent('install:start', data);
      this.logger.info(`Package: ${data.packageName} (${data.packageType ?? 'unknown'})`);
    });

    emitter.on('connection:start', (data: any) => {
      this.recordEvent('connection:start', data);
      this.logger.debug(`Connecting to ${data.username}...`);
    });

    emitter.on('connection:complete', (data: any) => {
      this.recordEvent('connection:complete', data);
      this.logger.debug(`Connected to org ${data.orgId ?? data.username}`);
    });

    emitter.on('deployment:start', (data: any) => {
      this.recordEvent('deployment:start', data);
      this.logger.info('Source deployment started');
    });

    emitter.on('deployment:progress', (data: any) => {
      this.recordEvent('deployment:progress', data);
      if (data.status) {
        this.logger.debug(`Deployment status: ${data.status}`);
      }
    });

    emitter.on('deployment:complete', (data: any) => {
      this.recordEvent('deployment:complete', data);
      this.logger.info(`Deployment complete (${data.componentCount ?? '?'} components)`);
    });

    emitter.on('version-install:start', (data: any) => {
      this.recordEvent('version-install:start', data);
      this.logger.info(`Installing package version ${data.packageVersionId ?? ''}`);
    });

    emitter.on('version-install:progress', (data: any) => {
      this.recordEvent('version-install:progress', data);
      if (data.status) {
        this.logger.debug(`Version install status: ${data.status}`);
      }
    });

    emitter.on('version-install:complete', (data: any) => {
      this.recordEvent('version-install:complete', data);
      this.logger.info('Version install complete');
    });

    emitter.on('install:skip', (data: any) => {
      this.recordEvent('install:skip', data);
      this.logger.info(`Skipped: ${data.packageName} (${data.reason ?? 'already installed'})`);
    });

    emitter.on('install:complete', (data: any) => {
      this.recordEvent('install:complete', data);
      this.logger.info(`Installed: ${data.packageName} v${data.version ?? '?'}`);
    });

    emitter.on('install:error', (data: any) => {
      this.recordEvent('install:error', data);
      this.logger.error(`Failed: ${data.packageName} — ${data.error ?? 'unknown error'}`);
    });

    emitter.on('orchestration:package:complete', (data: any) => {
      this.recordEvent('orchestration:package:complete', data);
      if (isStructuredLogger(this.logger)) {
        this.logger.groupEnd();
      }

      this.currentPackage = undefined;
    });

    emitter.on('orchestration:complete', (data: any) => {
      this.recordEvent('orchestration:complete', data);
    });
  }

  /**
   * Attach to a pool manager to render provisioning progress.
   */
  public attachToManager(emitter: EventEmitter): void {
    emitter.on('pool:provision:start', (data: any) => {
      this.startTime = new Date();
      this.recordEvent('pool:provision:start', data);
      if (isStructuredLogger(this.logger)) {
        this.logger.group(`Provisioning pool "${data.tag}"`);
      }

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
      if (isStructuredLogger(this.logger)) {
        this.logger.groupEnd();
      }
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
   * Print a summary of all events for the GitHub Actions log.
   */
  public printSummary(): void {
    const duration = this.startTime
      ? Math.round((Date.now() - this.startTime.getTime()) / 1000)
      : undefined;

    if (isStructuredLogger(this.logger)) {
      this.logger.group('Summary');
    }

    this.logger.info(`Total events: ${this.events.length}`);
    if (duration !== undefined) {
      this.logger.info(`Total duration: ${duration}s`);
    }

    const errors = this.events.filter(e => e.type.endsWith(':error'));
    if (errors.length > 0) {
      this.logger.error(`Errors: ${errors.length}`);
      for (const err of errors) {
        this.logger.error(`  ${err.data.packageName ?? 'unknown'}: ${err.data.error ?? 'unknown error'}`);
      }
    }

    if (isStructuredLogger(this.logger)) {
      this.logger.groupEnd();
    }
  }

  // --------------------------------------------------------------------------
  // Private
  // --------------------------------------------------------------------------

  private recordEvent(type: string, data: Record<string, unknown>): void {
    this.events.push({data, timestamp: new Date(), type});
  }
}
