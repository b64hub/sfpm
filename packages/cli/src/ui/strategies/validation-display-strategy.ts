import chalk from 'chalk';
import {Listr} from 'listr2';

import type {OutputLogger, OutputMode} from '../renderer-utils.js';

import {createDeferred, type Deferred} from '../orchestration-listr.js';
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
// ValidationListrManager (used by InteractiveValidationDisplay only)
// ============================================================================

/**
 * Manages flat concurrent Listr tasks for per-package validation progress.
 * Each package gets one task: spinner while pending, ✔ or ✖ on result.
 *
 * `start()` resolves once the spinner is live (first task invoked, which Listr
 * only does after its async render() completes) — a deterministic readiness
 * signal, no timing guesswork. `whenDone()` resolves once run() finishes and
 * the final frame is painted.
 */
class ValidationListrManager {
  private readonly deferreds = new Map<string, Deferred>();
  private runPromise?: Promise<unknown>;
  private readonly taskRefs = new Map<string, any>();

  fail(packageName: string, detail: string): void {
    // Title and error message must be identical: Listr2's dump() skips
    // the [FAILED: ...] suffix when error.message === task.title (v8 line 1075).
    const title = `${chalk.cyan(packageName)}${detail}`;
    const task = this.taskRefs.get(packageName);
    if (task) task.title = title;
    this.deferreds.get(packageName)?.reject(new Error(title));
  }

  pass(packageName: string, detail: string): void {
    const task = this.taskRefs.get(packageName);
    if (task) task.title = `${chalk.cyan(packageName)}${detail}`;
    this.deferreds.get(packageName)?.resolve();
  }

  /**
   * Build and run the Listr. Returns a promise that resolves once the spinner
   * is live (the first task callback fires only after render() completes).
   */
  start(packageNames: string[]): Promise<void> {
    const ready = createDeferred();
    let signalled = false;

    for (const name of packageNames) {
      this.deferreds.set(name, createDeferred());
    }

    const listr = new Listr(
      packageNames.map(name => ({
        exitOnError: false,
        task: (_ctx: unknown, task: any) => {
          this.taskRefs.set(name, task);
          if (!signalled) {
            signalled = true;
            ready.resolve();
          }

          return this.deferreds.get(name)!.promise;
        },
        title: chalk.dim(name),
      })),
      {concurrent: true, rendererOptions: {collapseErrors: false}},
    );

    this.runPromise = listr.run().catch(() => {});
    return ready.promise;
  }

  status(packageName: string, text: string): void {
    const task = this.taskRefs.get(packageName);
    if (task) task.title = `${chalk.cyan(packageName)} ${chalk.dim(text)}`;
  }

  async whenDone(): Promise<void> {
    await this.runPromise;
  }
}

// ============================================================================
// Interactive
// ============================================================================

export class InteractiveValidationDisplay implements ValidationDisplayStrategy {
  private readonly listr = new ValidationListrManager();
  private readonly logger: OutputLogger;

  constructor(logger: OutputLogger) {
    this.logger = logger;
  }

  async begin(packageNames: string[]): Promise<void> {
    const count = packageNames.length;
    const label = count === 1 ? 'validation' : 'validations';
    this.logger.log('\n');
    this.logger.log(`${chalk.bold('Resolving')} ${chalk.cyan(String(count))} ${label}`);
    await this.listr.start(packageNames);
  }

  complete(passed: number, failed: number, timedOut: number, total: number): void {
    const parts: string[] = [];
    if (passed > 0) parts.push(chalk.green(`${passed} passed`));
    if (failed > 0) parts.push(chalk.red(`${failed} failed`));
    if (timedOut > 0) parts.push(chalk.yellow(`${timedOut} timed out`));
    this.logger.log('\n');
    this.logger.log(`${chalk.bold('Validation')} ${parts.join(chalk.dim(', '))} ${chalk.dim(`(${total} total)`)}`);
  }

  end(): Promise<void> {
    return this.listr.whenDone();
  }

  packageFail(packageName: string, detail: string): void {
    this.listr.fail(packageName, detail);
  }

  packagePass(packageName: string, detail: string): void {
    this.listr.pass(packageName, detail);
  }

  packageStatus(packageName: string, text: string): void {
    this.listr.status(packageName, text);
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
