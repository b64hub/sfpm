import type {
  ResolveCompleteEvent,
  ResolveFailedEvent,
  ResolvePassedEvent,
  ResolveStartEvent,
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
 * Translates {@link ValidationEventBus} events into display strategy calls.
 * The renderer owns event-to-semantic translation; the display strategy
 * (interactive, plain, silent) owns how that is rendered.
 *
 * Interactive mode shows a per-package Listr task (spinner while pending,
 * ✔ or ✖ on completion). Plain mode logs one line per result.
 */
export class ValidationProgressRenderer {
  private readonly display: ValidationDisplayStrategy;

  constructor(mode: OutputMode, log: OutputLogger) {
    this.display = createValidationDisplayStrategy(mode, log);
  }

  /**
   * Attach to a validation event bus and start listening.
   */
  public attachTo(bus: ValidationEventBus): void {
    bus.on('resolve:start', event => this.onStart(event));
    bus.on('resolve:status', event => this.onStatus(event));
    bus.on('resolve:passed', event => this.onPassed(event));
    bus.on('resolve:failed', event => this.onFailed(event));
    bus.on('resolve:timeout', event => this.onTimeout(event));
    bus.on('resolve:complete', event => this.onComplete(event));
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
    this.display.complete(event.passed, event.failed, event.timedOut, event.total);
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

  private onStart(event: ResolveStartEvent): void {
    const {packageNames} = event;
    this.display.start(packageNames.length, packageNames.length === 1 ? 'validation' : 'validations');
    this.display.packageStart(packageNames);
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
