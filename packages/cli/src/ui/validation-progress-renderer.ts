import type {
  ResolveCompleteEvent,
  ResolveFailedEvent,
  ResolvePassedEvent,
  ResolveStatusEvent,
  ResolveTimeoutEvent,
  ValidationEventBus,
} from '@b64hub/sfpm-core';

import chalk from 'chalk';

import type {OutputLogger, OutputMode} from './renderer-utils.js';
import type {ValidationDisplayStrategy} from './strategies/validation-display-strategy.js';

import {formatDuration} from './renderer-utils.js';
import {createValidationDisplayStrategy} from './strategies/validation-display-strategy.js';

export type {OutputMode} from './renderer-utils.js';

// ============================================================================
// ValidationProgressRenderer
// ============================================================================

/**
 * Renders post-build validation resolution progress.
 *
 * Translates {@link ValidationEventBus} progress events into display strategy
 * calls. The UI lifecycle is driven explicitly by the caller, not by events,
 * so the spinner is guaranteed live before validation work starts and its
 * final frame is painted before the process may exit:
 *
 *   await renderer.begin(packageNames);   // spinner live
 *   await resolver.resolve(...);          // work → progress events
 *   await renderer.end();                 // final paint + summary
 *
 * Interactive mode shows a per-package Listr task (spinner while pending,
 * ✔ or ✖ on completion). Plain mode logs one line per result.
 */
export class ValidationProgressRenderer {
  private readonly display: ValidationDisplayStrategy;
  private summary?: {failed: number; passed: number; timedOut: number; total: number};

  constructor(mode: OutputMode, log: OutputLogger) {
    this.display = createValidationDisplayStrategy(mode, log);
  }

  /**
   * Attach to a validation event bus and listen for per-package progress.
   * Call {@link begin} to start the UI and {@link end} to finish it.
   */
  public attachTo(bus: ValidationEventBus): void {
    bus.on('resolve:status', event => this.onStatus(event));
    bus.on('resolve:passed', event => this.onPassed(event));
    bus.on('resolve:failed', event => this.onFailed(event));
    bus.on('resolve:timeout', event => this.onTimeout(event));
    bus.on('resolve:complete', event => this.onComplete(event));
  }

  /**
   * Start the UI for the given packages. Resolves only once the display is
   * live (interactive: the Listr spinner is registered). Await this BEFORE
   * starting event-loop-heavy validation work, otherwise the work can starve
   * the async render setup and the spinner never appears.
   */
  public begin(packageNames: string[]): Promise<void> {
    return this.display.begin(packageNames);
  }

  /**
   * Finish the UI: await the final render, then write the summary line. Await
   * this before the process may exit (e.g. before `this.error({exit})`), so the
   * validation Listr is not abandoned mid-paint.
   */
  public async end(): Promise<void> {
    await this.display.end();
    if (this.summary) {
      const {failed, passed, timedOut, total} = this.summary;
      this.display.complete(passed, failed, timedOut, total);
    }
  }

  // ========================================================================
  // Event handlers
  // ========================================================================

  private colorCoverage(coverage: number): string {
    if (coverage < 75) return chalk.red(`${coverage}% coverage`);
    if (coverage < 90) return chalk.yellow(`${coverage}% coverage`);
    return chalk.green(`${coverage}% coverage`);
  }

  private formatDetails(deployed?: number, total?: number, coverage?: number): string {
    if (deployed !== undefined && total !== undefined && coverage !== undefined) {
      return ` ${chalk.dim('(')}${deployed}/${total} deployed, ${this.colorCoverage(coverage)}${chalk.dim(')')}`;
    }

    if (deployed !== undefined && total !== undefined) {
      return ` ${chalk.dim('(')}${deployed}/${total} deployed${chalk.dim(')')}`;
    }

    if (coverage !== undefined) {
      return ` ${chalk.dim('(')}${this.colorCoverage(coverage)}${chalk.dim(')')}`;
    }

    return '';
  }

  private onComplete(event: ResolveCompleteEvent): void {
    // Defer the summary line until end(), after the Listr paints its final
    // task states — otherwise the summary would print above the ✔/✖ rows.
    this.summary = {
      failed: event.failed, passed: event.passed, timedOut: event.timedOut, total: event.total,
    };
  }

  private onFailed(event: ResolveFailedEvent): void {
    const components = this.formatDetails(event.componentsDeployed, event.componentsTotal, event.codeCoverage);
    const detail = `${components} ${chalk.dim('—')} ${chalk.red(event.error)}`;
    this.display.packageFail(event.packageName, detail);
  }

  private onPassed(event: ResolvePassedEvent): void {
    const detail = this.formatDetails(event.componentsDeployed, event.componentsTotal, event.codeCoverage);
    this.display.packagePass(event.packageName, detail);
  }

  // ========================================================================
  // Formatting helpers
  // ========================================================================

  private onStatus(event: ResolveStatusEvent): void {
    const text = event.status === 'polling'
      ? `polling${event.attempt ? ` (attempt ${event.attempt})` : ''}`
      : event.status === 'queued'
        ? `queued${event.waitingFor ? ` — waiting for ${event.waitingFor}` : ''}`
        : 'validating...';
    this.display.packageStatus(event.packageName, text);
  }

  private onTimeout(event: ResolveTimeoutEvent): void {
    const detail = ` ${chalk.dim('—')} ${chalk.yellow('timed out')} ${chalk.dim(`after ${formatDuration(event.elapsedMs)}`)}`;
    this.display.packageFail(event.packageName, detail);
  }
}
