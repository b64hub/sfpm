import chalk from 'chalk';

import type {OutputLogger} from '../renderer-utils.js';
import type {CompleteSummary, DisplayStrategy} from './display-strategy.js';

import {successBox, warningBox} from '../boxes.js';
import {OrchestrationListrManager} from '../orchestration-listr.js';
import {sym} from '../renderer-utils.js';

// ============================================================================
// Interactive Display Strategy
// ============================================================================

/**
 * Rich interactive display using Listr for orchestrated output.
 * Always treats execution as orchestration (even for a single package).
 *
 * The Listr layout per package:
 * ```
 * ├── @scope/name
 * │   ├── pre-hooks
 * │   ├── building... (rolling title)
 * │   ├── post-hooks
 * │   └── validation queued (optional)
 * ```
 */
export class InteractiveDisplay implements DisplayStrategy {
  private readonly listr: OrchestrationListrManager;
  private readonly logger: OutputLogger;

  constructor(logger: OutputLogger) {
    this.logger = logger;
    this.listr = new OrchestrationListrManager();
  }

  // ===========================================================================
  // Orchestration Lifecycle
  // ===========================================================================

  complete(summary: CompleteSummary): void {
    this.listr.destroy();

    this.logger.log('');

    // Render final package list (clearOutput: true erases the dynamic listr output)
    for (const pkg of summary.packages) {
      if (pkg.skipped) {
        this.logger.log(`  ${sym.skip} ${chalk.cyan(pkg.name)} ${chalk.dim(`— ${pkg.error || 'skipped'}`)}`);
      } else if (pkg.success) {
        this.logger.log(`  ${sym.success} ${chalk.cyan(pkg.name)}${pkg.duration ? ` ${chalk.gray(`(${pkg.duration})`)}` : ''}`);
      } else {
        this.logger.log(`  ${sym.fail} ${chalk.cyan(pkg.name)}${pkg.error ? ` ${chalk.red(`— ${pkg.error}`)}` : ''}`);
      }
    }

    this.logger.log('');

    const entries: Record<string, string> = {
      Succeeded: String(summary.succeeded),
      'Total Packages': String(summary.packages.length),
    };
    if (summary.failed > 0) entries.Failed = chalk.red(String(summary.failed));
    if (summary.skipped > 0) entries.Skipped = chalk.yellow(String(summary.skipped));
    entries.Duration = summary.duration;

    const allSucceeded = summary.failed === 0;
    const title = allSucceeded ? 'Orchestration Complete' : 'Orchestration Complete (with failures)';

    if (allSucceeded) {
      this.logger.log(successBox(title, entries));
    } else {
      this.logger.log(warningBox(title, entries));
    }
  }

  error(_error: Error): void {
    // Listr handles error display via rejected tasks
  }

  info(message: string): void {
    this.logger.log(chalk.dim(`  ${message}`));
  }

  levelStart(level: number, packages: string[]): void {
    this.listr.onLevelStart(level, packages);
  }

  // ===========================================================================
  // Package-Level
  // ===========================================================================

  packageComplete(packageName: string, duration: string): void {
    this.listr.skipHooks(packageName, 'post');
    this.listr.updatePackageTitle(
      packageName,
      `${chalk.cyan(packageName)} ${chalk.gray(`(${duration})`)}`,
    );
    this.listr.resolvePackage(packageName);
  }

  packageFail(packageName: string, error?: string): void {
    this.listr.rejectPackage(packageName, error ?? 'Failed');
  }

  packageSkip(packageName: string, reason: string): void {
    this.listr.updatePackageTitle(
      packageName,
      `${sym.skip} ${chalk.cyan(packageName)} ${chalk.dim(`— ${reason}`)}`,
    );
    this.listr.resolvePackage(packageName);
  }

  packageStart(packageName: string): void {
    this.listr.updatePackageTitle(packageName, chalk.cyan(packageName));
  }

  // ===========================================================================
  // Subtask-Level
  // ===========================================================================

  start(title: string, _packages: string[], levels?: string[][]): void {
    this.logger.log(chalk.bold(`\n${title}`));
    this.logger.log('');
    // Fall back to a single level if the orchestrator didn't provide levels
    this.listr.start(levels ?? [_packages]);
  }

  subtaskComplete(packageName: string, phase: string, detail?: string): void {
    if (phase === 'pre-hooks' || phase === 'post-hooks') {
      const timing = phase === 'pre-hooks' ? 'pre' : 'post';
      const text = detail ?? phase;
      this.listr.completeHooks(packageName, 0, timing, 'build', text);
    } else {
      this.listr.updateBuildTitle(packageName, detail ?? phase);
    }
  }

  subtaskSkip(packageName: string, phase: string): void {
    if (phase === 'pre-hooks' || phase === 'post-hooks') {
      const timing = phase === 'pre-hooks' ? 'pre' : 'post';
      this.listr.skipHooks(packageName, timing);
    } else if (phase === 'validation') {
      // no-op — validation slot just doesn't activate
    } else {
      this.listr.updateBuildTitle(packageName, chalk.dim(`${phase} — skipped`));
    }
  }

  subtaskStart(packageName: string, phase: string): void {
    if (phase === 'pre-hooks' || phase === 'post-hooks') {
      // Hook slot activation handled via subtaskUpdate with hook names
      return;
    }

    if (phase === 'validation') {
      this.listr.markValidationQueued(packageName);
      return;
    }

    // For the main build/install phase, skip pre-hooks if they weren't started
    this.listr.skipHooks(packageName, 'pre');
    this.listr.updateBuildTitle(packageName, `${phase}...`);
  }

  // ===========================================================================
  // Informational
  // ===========================================================================

  subtaskUpdate(packageName: string, phase: string, status: string): void {
    if (phase === 'pre-hooks' || phase === 'post-hooks') {
      const timing = phase === 'pre-hooks' ? 'pre' : 'post';
      // Use startHooks for the initial hook activation
      this.listr.startHooks(packageName, [status], timing, 'build');
    } else {
      this.listr.updateBuildTitle(packageName, status);
    }
  }

  warn(message: string): void {
    this.logger.log(`  ${sym.warn} ${message}`);
  }
}
