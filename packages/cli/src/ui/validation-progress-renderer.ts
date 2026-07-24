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

import {formatDuration, sym} from './renderer-utils.js';
import {createValidationDisplayStrategy} from './strategies/validation-display-strategy.js';

// ============================================================================
// Per-package tracking
// ============================================================================

interface PackageState {
  startedAt?: number;
  status: 'done' | 'failed' | 'polling' | 'queued' | 'timed-out';
}

// ============================================================================
// ValidationProgressRenderer
// ============================================================================

/**
 * Renders post-build validation resolution progress.
 *
 * Translates {@link ValidationEventBus} events into display strategy calls.
 * The renderer owns event-to-semantic translation; the display strategy
 * (interactive, plain, silent) owns how that is rendered.
 */
export class ValidationProgressRenderer {
  private readonly display: ValidationDisplayStrategy;
  private readonly packages = new Map<string, PackageState>();

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
  // Event Handlers
  // ========================================================================

  /**
   * Color a coverage percentage: red (<75), yellow (75–89), green (90+).
   */
  private colorCoverage(coverage: number): string {
    const label = `${coverage}%`;
    if (coverage >= 90) return chalk.dim.green(label);
    if (coverage >= 75) return chalk.dim.yellow(label);
    return chalk.dim.red(label);
  }

  /**
   * Build a dimmed parenthetical detail string with component counts and coverage.
   */
  private formatDetails(deployed?: number, total?: number, coverage?: number): string {
    if (deployed === undefined && total === undefined && coverage === undefined) return '';

    if (deployed !== undefined && total !== undefined && coverage !== undefined) {
      return ` ${chalk.dim(`(${deployed}/${total} deployed,`)} ${this.colorCoverage(coverage)}${chalk.dim(')')}`;
    }

    if (coverage !== undefined) {
      return ` ${chalk.dim('(')}${this.colorCoverage(coverage)}${chalk.dim(')')}`;
    }

    return chalk.dim(` (${deployed}/${total} deployed)`);
  }

  private onComplete(event: ResolveCompleteEvent): void {
    this.display.complete(event.passed, event.failed, event.timedOut, event.total);
  }

  private onFailed(event: ResolveFailedEvent): void {
    const name = (event as any).packageName ?? 'unknown';
    this.packages.set(name, {status: 'failed'});
    const details = this.formatDetails(event.componentsDeployed, event.componentsTotal, event.codeCoverage);
    this.display.result(
      `${sym.fail} ${chalk.cyan(name)}${details} ${chalk.dim('—')} ${chalk.red(event.error)}`,
      this.remainingCount(),
    );
  }

  private onPassed(event: ResolvePassedEvent): void {
    const name = (event as any).packageName ?? 'unknown';
    this.packages.set(name, {status: 'done'});
    const details = this.formatDetails(event.componentsDeployed, event.componentsTotal, event.codeCoverage);
    this.display.result(`${sym.success} ${chalk.cyan(name)}${details}`, this.remainingCount());
  }

  private onStart(event: ResolveStartEvent): void {
    for (const name of event.packageNames) {
      this.packages.set(name, {startedAt: Date.now(), status: 'queued'});
    }

    const count = event.packageNames.length;
    this.display.start(count, count === 1 ? 'validation' : 'validations');
  }

  // ========================================================================
  // Formatting helpers
  // ========================================================================

  private onStatus(event: ResolveStatusEvent): void {
    const name = (event as any).packageName ?? 'unknown';
    const pkg = this.packages.get(name) ?? {status: 'queued'};
    pkg.status = event.status === 'in-progress' || event.status === 'polling' ? 'polling' : 'queued';
    this.packages.set(name, pkg);

    const statusLabel = event.status === 'polling'
      ? `Polling ${chalk.cyan(name)}`
      : event.status === 'queued'
        ? `Queued ${chalk.dim(name)}`
        : `Resolving ${chalk.cyan(name)}`;

    const attempt = event.attempt ? chalk.dim(` (attempt ${event.attempt})`) : '';
    const waiting = event.waitingFor ? chalk.dim(` waiting for ${event.waitingFor}`) : '';
    this.display.status(`${statusLabel}${attempt}${waiting}`);
  }

  private onTimeout(event: ResolveTimeoutEvent): void {
    const name = (event as any).packageName ?? 'unknown';
    this.packages.set(name, {status: 'timed-out'});
    this.display.result(
      `${sym.warn} ${chalk.bold(name)} ${chalk.yellow('timed out')} ${chalk.dim(`after ${formatDuration(event.elapsedMs)}`)}`,
      this.remainingCount(),
    );
  }

  private remainingCount(): number {
    return [...this.packages.values()].filter(s => s.status === 'polling' || s.status === 'queued').length;
  }
}
