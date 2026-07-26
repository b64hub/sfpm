import chalk from 'chalk';
import ora, {type Ora} from 'ora';

import type {OutputLogger, OutputMode} from '../renderer-utils.js';

import {sym} from '../renderer-utils.js';

// ============================================================================
// ValidationDisplayStrategy Interface
// ============================================================================

/**
 * Abstraction over how validation resolution progress is rendered.
 *
 * Lifecycle is explicit so callers can guarantee ordering around
 * event-loop-heavy work:
 *
 *   await display.begin(names);   // returns only once the UI is LIVE
 *   ... run validation work, calling packagePass/Fail/Status ...
 *   await display.end();          // returns once the final frame is painted
 *   display.complete(...);        // summary line
 */
export interface ValidationDisplayStrategy {
  /**
   * Initialize the UI for the given packages. Resolves only once the display
   * is actually live — for interactive mode that means the Listr spinner has
   * been registered (its async render() finished). Awaiting this before
   * starting heavy work prevents the work from starving spinner setup.
   */
  begin(packageNames: string[]): Promise<void>;
  /** Write the final summary line. Call after {@link end}. */
  complete(passed: number, failed: number, timedOut: number, total: number): void;
  /**
   * Resolve once the UI has painted its final state. Await this before the
   * process may exit, otherwise the render is abandoned mid-paint.
   */
  end(): Promise<void>;
  /** Mark a package as failed. `detail` is the pre-formatted annotation. */
  packageFail(packageName: string, detail: string): void;
  /** Mark a package as passed. `detail` is the pre-formatted annotation. */
  packagePass(packageName: string, detail: string): void;
  /** Update a package's in-progress status label (e.g. polling attempt). */
  packageStatus(packageName: string, text: string): void;
}

// ============================================================================
// Interactive
// ============================================================================

export class InteractiveValidationDisplay implements ValidationDisplayStrategy {
  private readonly logger: OutputLogger;
  private spinner?: Ora;

  constructor(logger: OutputLogger) {
    this.logger = logger;
  }

  async begin(packageNames: string[]): Promise<void> {
    const count = packageNames.length;
    const label = count === 1 ? 'validation' : 'validations';
    this.logger.log(`\n${chalk.bold('Resolving')} ${chalk.cyan(String(count))} ${label}`);
    this.spinner = ora({text: 'Validating packages…'}).start();
  }

  complete(passed: number, failed: number, timedOut: number, total: number): void {
    const parts: string[] = [];
    if (passed > 0) parts.push(chalk.green(`${passed} passed`));
    if (failed > 0) parts.push(chalk.red(`${failed} failed`));
    if (timedOut > 0) parts.push(chalk.yellow(`${timedOut} timed out`));
    this.logger.log(`\n${chalk.bold('Validation')} ${parts.join(chalk.dim(', '))} ${chalk.dim(`(${total} total)`)}`);
  }

  async end(): Promise<void> {
    this.spinner?.stop();
    this.spinner = undefined;
  }

  packageFail(packageName: string, detail: string): void {
    this.spinner?.clear();
    this.logger.log(`  ${sym.fail} ${chalk.red(packageName)}${detail}`);
    this.spinner?.render();
  }

  packagePass(packageName: string, detail: string): void {
    this.spinner?.clear();
    this.logger.log(`  ${sym.success} ${chalk.cyan(packageName)}${detail}`);
    this.spinner?.render();
  }

  packageStatus(packageName: string, text: string): void {
    if (this.spinner) this.spinner.text = `${chalk.cyan(packageName)} ${chalk.dim(text)}`;
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

  async begin(packageNames: string[]): Promise<void> {
    const count = packageNames.length;
    const label = count === 1 ? 'validation' : 'validations';
    this.logger.log(`\n\n${chalk.bold('Resolving')} ${chalk.cyan(String(count))} ${label}`);
  }

  complete(passed: number, failed: number, timedOut: number, total: number): void {
    const parts: string[] = [];
    if (passed > 0) parts.push(chalk.green(`${passed} passed`));
    if (failed > 0) parts.push(chalk.red(`${failed} failed`));
    if (timedOut > 0) parts.push(chalk.yellow(`${timedOut} timed out`));
    this.logger.log('\n');
    this.logger.log(`${chalk.bold('Validation')} ${parts.join(chalk.dim(', '))} ${chalk.dim(`(${total} total)`)}`);
  }

  // Plain mode logs synchronously — nothing to await.
  async end(): Promise<void> {}

  packageFail(packageName: string, detail: string): void {
    this.logger.log(`  ${sym.fail} ${chalk.red(packageName)}${detail}`);
  }

  packagePass(packageName: string, detail: string): void {
    this.logger.log(`  ${sym.success} ${chalk.cyan(packageName)}${detail}`);
  }

  packageStatus(_packageName: string, _text: string): void {}
}

// ============================================================================
// Silent (JSON mode)
// ============================================================================

export class SilentValidationDisplay implements ValidationDisplayStrategy {
  async begin(_packageNames: string[]): Promise<void> {}

  complete(_passed: number, _failed: number, _timedOut: number, _total: number): void {}

  async end(): Promise<void> {}

  packageFail(_packageName: string, _detail: string): void {}

  packagePass(_packageName: string, _detail: string): void {}

  packageStatus(_packageName: string, _text: string): void {}
}

// ============================================================================
// Factory
// ============================================================================

export function createValidationDisplayStrategy(mode: OutputMode, logger: OutputLogger): ValidationDisplayStrategy {
  switch (mode) {
  case 'interactive': {return new InteractiveValidationDisplay(logger);}
  case 'json': {return new SilentValidationDisplay();}
  case 'plain': {return new PlainValidationDisplay(logger);}
  }
}
