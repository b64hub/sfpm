import chalk from 'chalk';
import ora, {type Ora} from 'ora';

import type {OutputLogger, OutputMode} from '../renderer-utils.js';

// ============================================================================
// Validation Display Strategy Interface
// ============================================================================

/**
 * Abstraction over how validation resolution progress is rendered.
 *
 * The renderer translates domain events into calls on this interface.
 * Each output mode (interactive, plain, json/silent) provides its own
 * implementation — spinner management stays out of the renderer.
 */
export interface ValidationDisplayStrategy {
  /** Stop spinner and write the final summary. */
  complete(passed: number, failed: number, timedOut: number, total: number): void;
  /** Write a pass/fail/timeout result line. `remaining` drives spinner restart. */
  result(line: string, remaining: number): void;
  /** Called when resolution begins. Shows header + starts spinner (interactive). */
  start(count: number, label: string): void;
  /** Update the in-progress status text (interactive spinner only). */
  status(text: string): void;
}

// ============================================================================
// Interactive
// ============================================================================

export class InteractiveValidationDisplay implements ValidationDisplayStrategy {
  private readonly logger: OutputLogger;
  private spinner: Ora | undefined;

  constructor(logger: OutputLogger) {
    this.logger = logger;
  }

  complete(passed: number, failed: number, timedOut: number, total: number): void {
    this.spinner?.stop();
    this.spinner = undefined;

    const parts: string[] = [];
    if (passed > 0) parts.push(chalk.green(`${passed} passed`));
    if (failed > 0) parts.push(chalk.red(`${failed} failed`));
    if (timedOut > 0) parts.push(chalk.yellow(`${timedOut} timed out`));

    this.logger.log(`\n  ${chalk.bold('Validation')} ${parts.join(chalk.dim(', '))} ${chalk.dim(`(${total} total)`)}`);
  }

  result(line: string, remaining: number): void {
    if (this.spinner) {
      this.spinner.clear();
      this.spinner.stop();
    }

    this.logger.log(`  ${line}`);

    if (this.spinner && remaining > 0) {
      this.spinner.text = `Resolving ${chalk.cyan(String(remaining))} remaining...`;
      this.spinner.start();
    }
  }

  start(count: number, label: string): void {
    this.logger.log(`\n\n${chalk.bold('Resolving')} ${chalk.cyan(String(count))} ${label}`);
    this.spinner = ora({prefixText: '', text: 'Waiting for results...'}).start();
  }

  status(text: string): void {
    if (this.spinner) this.spinner.text = text;
  }
}

// ============================================================================
// Plain
// ============================================================================

export class PlainValidationDisplay implements ValidationDisplayStrategy {
  private readonly logger: OutputLogger;

  constructor(logger: OutputLogger) {
    this.logger = logger;
  }

  complete(passed: number, failed: number, timedOut: number, total: number): void {
    const parts: string[] = [];
    if (passed > 0) parts.push(chalk.green(`${passed} passed`));
    if (failed > 0) parts.push(chalk.red(`${failed} failed`));
    if (timedOut > 0) parts.push(chalk.yellow(`${timedOut} timed out`));

    this.logger.log(`\n  ${chalk.bold('Validation')} ${parts.join(chalk.dim(', '))} ${chalk.dim(`(${total} total)`)}`);
  }

  result(line: string, _remaining: number): void {
    this.logger.log(`  ${line}`);
  }

  start(count: number, label: string): void {
    this.logger.log(`\n\n${chalk.bold('Resolving')} ${chalk.cyan(String(count))} ${label}`);
  }

  status(_text: string): void {}
}

// ============================================================================
// Silent (JSON mode)
// ============================================================================

export class SilentValidationDisplay implements ValidationDisplayStrategy {
  complete(_passed: number, _failed: number, _timedOut: number, _total: number): void {}

  result(_line: string, _remaining: number): void {}

  start(_count: number, _label: string): void {}

  status(_text: string): void {}
}

// ============================================================================
// Factory
// ============================================================================

export function createValidationDisplayStrategy(mode: OutputMode, logger: OutputLogger): ValidationDisplayStrategy {
  switch (mode) {
  case 'interactive': {return new InteractiveValidationDisplay(logger);
  }

  case 'json': {return new SilentValidationDisplay();
  }

  case 'plain': {return new PlainValidationDisplay(logger);
  }
  }
}
