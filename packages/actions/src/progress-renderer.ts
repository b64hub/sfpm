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
    private readonly events: EventRecord[] = [];
    private readonly logger: Logger;
    private currentPackage?: string;
    private startTime?: Date;

    constructor(logger: Logger) {
        this.logger = logger;
    }

    // --------------------------------------------------------------------------
    // Attach to emitters
    // --------------------------------------------------------------------------

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

    /**
     * Return collected events as a JSON-serializable array.
     */
    public getEventLog(): EventRecord[] {
        return [...this.events];
    }

    // --------------------------------------------------------------------------
    // Private
    // --------------------------------------------------------------------------

    private recordEvent(type: string, data: Record<string, unknown>): void {
        this.events.push({data, timestamp: new Date(), type});
    }
}
