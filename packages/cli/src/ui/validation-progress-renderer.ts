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
import ora, {Ora} from 'ora';

import type {OutputLogger, OutputMode} from './renderer-utils.js';

import {formatDuration} from './renderer-utils.js';

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
 * Standalone component — attach to a {@link ValidationEventBus} via
 * {@link attachTo}. Uses a single spinner with rolling text that
 * reflects the current polling state. The spinner is created once
 * on `resolve:start` and only its text is updated — never destroyed
 * and recreated — to avoid orphaned spinner lines in the terminal.
 */
export class ValidationProgressRenderer {
  private readonly log: OutputLogger;
  private readonly mode: OutputMode;
  private readonly packages = new Map<string, PackageState>();
  private spinner: Ora | undefined;

  constructor(mode: OutputMode, log: OutputLogger) {
    this.mode = mode;
    this.log = log;
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
   * e.g. ` (42/42 deployed, 87%)` or ` (87%)` or ``
   */
  private formatDetails(deployed?: number, total?: number, coverage?: number): string {
    const parts: string[] = [];

    if (deployed !== undefined && total !== undefined) {
      parts.push(`${deployed}/${total} deployed`);
    }

    if (coverage !== undefined) {
      parts.push(this.colorCoverage(coverage));
    }

    if (parts.length === 0) return '';

    // coverage is already colored, so build the string with dim for everything else
    if (deployed !== undefined && total !== undefined && coverage !== undefined) {
      return ` ${chalk.dim(`(${deployed}/${total} deployed,`)} ${this.colorCoverage(coverage)}${chalk.dim(')')}`;
    }

    if (coverage !== undefined) {
      return ` ${chalk.dim('(')}${this.colorCoverage(coverage)}${chalk.dim(')')}`;
    }

    return chalk.dim(` (${parts.join(', ')})`);
  }

  private onComplete(event: ResolveCompleteEvent): void {
    this.spinner?.stop();
    this.spinner = undefined;

    if (this.mode === 'json') return;

    const parts: string[] = [];
    if (event.passed > 0) parts.push(chalk.green(`${event.passed} passed`));
    if (event.failed > 0) parts.push(chalk.red(`${event.failed} failed`));
    if (event.timedOut > 0) parts.push(chalk.yellow(`${event.timedOut} timed out`));

    const summary = parts.join(chalk.dim(', '));
    this.log.log(`\n  ${chalk.bold('Validation')} ${summary} ${chalk.dim(`(${event.total} total)`)}`);
  }

  private onFailed(event: ResolveFailedEvent): void {
    const name = (event as any).packageName ?? 'unknown';
    this.packages.set(name, {status: 'failed'});

    if (this.mode === 'json') return;

    const details = this.formatDetails(event.componentsDeployed, event.componentsTotal, event.codeCoverage);
    this.writeResult(`${chalk.red('✖')} ${chalk.cyan(name)}${details} ${chalk.dim('—')} ${chalk.red(event.error)}`);
  }

  private onPassed(event: ResolvePassedEvent): void {
    const name = (event as any).packageName ?? 'unknown';
    this.packages.set(name, {status: 'done'});

    if (this.mode === 'json') return;

    const details = this.formatDetails(event.componentsDeployed, event.componentsTotal, event.codeCoverage);
    this.writeResult(`${chalk.green('✔')} ${chalk.cyan(name)}${details}`);
  }

  private onStart(event: ResolveStartEvent): void {
    for (const name of event.packageNames) {
      this.packages.set(name, {startedAt: Date.now(), status: 'queued'});
    }

    if (this.mode === 'json') return;

    const count = event.packageNames.length;
    const label = count === 1 ? 'validation' : 'validations';
    this.log.log(`\n\n${chalk.bold('Resolving')} ${chalk.cyan(String(count))} ${label}`);

    if (this.mode !== 'interactive') return;

    this.spinner = ora({
      prefixText: '',
      text: 'Waiting for results...',
    }).start();
  }

  // ========================================================================
  // Formatting helpers
  // ========================================================================

  private onStatus(event: ResolveStatusEvent): void {
    const name = (event as any).packageName ?? 'unknown';
    const pkg = this.packages.get(name) ?? {status: 'queued'};
    pkg.status = event.status === 'in-progress' || event.status === 'polling' ? 'polling' : 'queued';
    this.packages.set(name, pkg);

    if (!this.spinner || this.mode !== 'interactive') return;

    const statusLabel = event.status === 'polling'
      ? `Polling ${chalk.cyan(name)}`
      : event.status === 'queued'
        ? `Queued ${chalk.dim(name)}`
        : `Resolving ${chalk.cyan(name)}`;

    const attempt = event.attempt ? chalk.dim(` (attempt ${event.attempt})`) : '';
    const waiting = event.waitingFor ? chalk.dim(` waiting for ${event.waitingFor}`) : '';
    this.spinner.text = `${statusLabel}${attempt}${waiting}`;
  }

  private onTimeout(event: ResolveTimeoutEvent): void {
    const name = (event as any).packageName ?? 'unknown';
    this.packages.set(name, {status: 'timed-out'});

    if (this.mode === 'json') return;

    this.writeResult(`${chalk.yellow('⚠')} ${chalk.bold(name)} ${chalk.yellow('timed out')} ${chalk.dim(`after ${formatDuration(event.elapsedMs)}`)}`);
  }

  // ========================================================================
  // Output helpers
  // ========================================================================

  /**
   * Write a result line while preserving the single spinner.
   *
   * Clears the spinner line, writes the result, then restarts the
   * spinner with an updated "remaining" count — all on the same
   * {@link Ora} instance to avoid orphaned terminal lines.
   */
  private writeResult(line: string): void {
    if (this.spinner) {
      this.spinner.clear();
      // Temporarily stop so the log line isn't overwritten by the spinner frame
      this.spinner.stop();
    }

    this.log.log(`  ${line}`);

    // Resume the same spinner with an updated remaining count
    if (this.spinner && this.mode === 'interactive') {
      const remaining = [...this.packages.values()]
      .filter(s => s.status === 'polling' || s.status === 'queued')
      .length;

      if (remaining > 0) {
        this.spinner.text = `Resolving ${chalk.cyan(String(remaining))} remaining...`;
        this.spinner.start();
      }
    }
  }
}
