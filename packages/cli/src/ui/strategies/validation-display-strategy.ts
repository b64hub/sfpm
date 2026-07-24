import chalk from 'chalk';
import {Listr} from 'listr2';

import type {OutputLogger, OutputMode} from '../renderer-utils.js';

import {createDeferred, type Deferred} from '../orchestration-listr.js';
import {rawSym, sym} from '../renderer-utils.js';

// ============================================================================
// ValidationDisplayStrategy Interface
// ============================================================================

/**
 * Abstraction over how validation resolution progress is rendered.
 *
 * The renderer translates domain events into calls on this interface.
 * Each output mode (interactive, plain, json/silent) provides its own
 * implementation — spinner management stays out of the renderer.
 */
export interface ValidationDisplayStrategy {
  /** Stop tasks/spinner and write the final summary line. */
  complete(passed: number, failed: number, timedOut: number, total: number): void;
  /** Mark a package as failed. `detail` is the pre-formatted annotation. */
  packageFail(packageName: string, detail: string): void;
  /** Mark a package as passed. `detail` is the pre-formatted annotation. */
  packagePass(packageName: string, detail: string): void;
  /** Called with all package names when resolution begins. */
  packageStart(packageNames: string[]): void;
  /** Update a package's in-progress status label (e.g. polling attempt). */
  packageStatus(packageName: string, text: string): void;
  /** Called when resolution begins. Shows section header. */
  start(count: number, label: string): void;
}

// ============================================================================
// ValidationListrManager (used by InteractiveValidationDisplay only)
// ============================================================================

/**
 * Manages flat concurrent Listr tasks for per-package validation progress.
 * Each package gets one task: spinner while pending, ✔ or ✖ on result.
 *
 * Uses the same deferred-promise pattern as {@link OrchestrationListrManager}.
 */
class ValidationListrManager {
  private readonly deferreds = new Map<string, Deferred>();
  private readonly taskRefs = new Map<string, any>();

  fail(packageName: string, detail: string): void {
    // Title and error message must be identical: Listr2's dump() skips
    // the [FAILED: ...] suffix when error.message === task.title (v8 line 1075).
    const title = `${chalk.cyan(packageName)}${detail}`;
    const task = this.taskRefs.get(packageName);
    if (task) task.title = title;
    this.deferreds.get(packageName)?.reject(new Error(title));
  }

  init(packageNames: string[]): void {
    for (const name of packageNames) {
      this.deferreds.set(name, createDeferred());
    }

    const listr = new Listr(
      packageNames.map(name => ({
        exitOnError: false,
        task: (_ctx: unknown, task: any) => {
          this.taskRefs.set(name, task);
          return this.deferreds.get(name)!.promise;
        },
        title: chalk.dim(name),
      })),
      {
        concurrent: true,
        exitOnError: false,
        rendererOptions: {
          icon: {SKIPPED_WITH_COLLAPSE: rawSym.skip},
        },
      },
    );

    listr.run().catch(() => {});
  }

  pass(packageName: string, detail: string): void {
    const task = this.taskRefs.get(packageName);
    if (task) task.title = `${chalk.cyan(packageName)}${detail}`;
    this.deferreds.get(packageName)?.resolve();
  }

  status(packageName: string, text: string): void {
    const task = this.taskRefs.get(packageName);
    if (task) task.title = `${chalk.cyan(packageName)} ${chalk.dim(text)}`;
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

  complete(passed: number, failed: number, timedOut: number, total: number): void {
    const parts: string[] = [];
    if (passed > 0) parts.push(chalk.green(`${passed} passed`));
    if (failed > 0) parts.push(chalk.red(`${failed} failed`));
    if (timedOut > 0) parts.push(chalk.yellow(`${timedOut} timed out`));
    this.logger.log(`\n  ${chalk.bold('Validation')} ${parts.join(chalk.dim(', '))} ${chalk.dim(`(${total} total)`)}`);
  }

  packageFail(packageName: string, detail: string): void {
    this.listr.fail(packageName, detail);
  }

  packagePass(packageName: string, detail: string): void {
    this.listr.pass(packageName, detail);
  }

  packageStart(packageNames: string[]): void {
    this.listr.init(packageNames);
  }

  packageStatus(packageName: string, text: string): void {
    this.listr.status(packageName, text);
  }

  start(count: number, label: string): void {
    this.logger.log(`\n\n${chalk.bold('Resolving')} ${chalk.cyan(String(count))} ${label}`);
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

  packageFail(packageName: string, detail: string): void {
    this.logger.log(`  ${sym.fail} ${chalk.red(packageName)}${detail}`);
  }

  packagePass(packageName: string, detail: string): void {
    this.logger.log(`  ${sym.success} ${chalk.cyan(packageName)}${detail}`);
  }

  packageStart(_packageNames: string[]): void {}

  packageStatus(_packageName: string, _text: string): void {}

  start(count: number, label: string): void {
    this.logger.log(`\n\n${chalk.bold('Resolving')} ${chalk.cyan(String(count))} ${label}`);
  }
}

// ============================================================================
// Silent (JSON mode)
// ============================================================================

export class SilentValidationDisplay implements ValidationDisplayStrategy {
  complete(_passed: number, _failed: number, _timedOut: number, _total: number): void {}

  packageFail(_packageName: string, _detail: string): void {}

  packagePass(_packageName: string, _detail: string): void {}

  packageStart(_packageNames: string[]): void {}

  packageStatus(_packageName: string, _text: string): void {}

  start(_count: number, _label: string): void {}
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
