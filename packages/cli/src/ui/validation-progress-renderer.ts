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

  private onComplete(event: ResolveCompleteEvent): void {
    this.spinner?.stop();
    this.spinner = undefined;

    if (this.mode === 'json') return;

    const parts: string[] = [];
    if (event.passed > 0) parts.push(chalk.green(`${event.passed} passed`));
    if (event.failed > 0) parts.push(chalk.red(`${event.failed} failed`));
    if (event.timedOut > 0) parts.push(chalk.yellow(`${event.timedOut} timed out`));

    const summary = parts.join(chalk.dim(', '));
    this.log.log(`\n${chalk.bold('Validation')} ${summary} ${chalk.dim(`(${event.total} total)`)}`);
  }

  private onFailed(event: ResolveFailedEvent): void {
    const name = (event as any).packageName ?? 'unknown';
    this.packages.set(name, {status: 'failed'});

    if (this.mode === 'quiet' || this.mode === 'json') return;

    const coverage = event.codeCoverage === undefined ? '' : chalk.dim(` (${event.codeCoverage}%)`);
    this.writeResult(`${chalk.red('✖')} ${chalk.bold(name)}${coverage} ${chalk.dim('—')} ${chalk.red(event.error)}`);
  }

  private onPassed(event: ResolvePassedEvent): void {
    const name = (event as any).packageName ?? 'unknown';
    this.packages.set(name, {status: 'done'});

    if (this.mode === 'quiet' || this.mode === 'json') return;

    const coverage = event.codeCoverage === undefined ? '' : chalk.dim(` (${event.codeCoverage}% coverage)`);
    this.writeResult(`${chalk.green('✔')} ${chalk.bold(name)}${coverage}`);
  }

  private onStart(event: ResolveStartEvent): void {
    for (const name of event.packageNames) {
      this.packages.set(name, {startedAt: Date.now(), status: 'queued'});
    }

    if (this.mode !== 'interactive') return;

    const count = event.packageNames.length;
    const label = count === 1 ? 'validation' : 'validations';
    this.spinner = ora({
      prefixText: '',
      text: `Resolving ${chalk.cyan(String(count))} ${label}...`,
    }).start();
  }

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

    if (this.mode === 'quiet' || this.mode === 'json') return;

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
