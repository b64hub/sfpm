import chalk from 'chalk';

import type {OutputLogger} from '../renderer-utils.js';
import type {CompleteSummary, DisplayStrategy} from './display-strategy.js';

import {sym} from '../renderer-utils.js';

// ============================================================================
// Plain Display Strategy
// ============================================================================

/**
 * Line-by-line display for non-interactive environments (CI, turborepo, piped output).
 * Uses colors and UTF-8 symbols but no cursor movement, spinners, or boxes.
 */
export class PlainDisplay implements DisplayStrategy {
  private readonly logger: OutputLogger;

  constructor(logger: OutputLogger) {
    this.logger = logger;
  }

  complete(summary: CompleteSummary): void {
    this.logger.log('');

    const parts: string[] = [];
    if (summary.succeeded > 0) parts.push(chalk.green(`${summary.succeeded} succeeded`));
    if (summary.failed > 0) parts.push(chalk.red(`${summary.failed} failed`));
    if (summary.skipped > 0) parts.push(chalk.yellow(`${summary.skipped} skipped`));

    this.logger.log(`Done in ${summary.duration} — ${parts.join(', ')}`);
  }

  error(error: Error): void {
    this.logger.error(`${sym.fail} ${error.message}`);
  }

  info(message: string): void {
    this.logger.log(chalk.dim(`  ${message}`));
  }

  levelStart(_level: number, _packages: string[]): void {
    // Plain mode doesn't show level separators
  }

  packageComplete(packageName: string, duration: string): void {
    this.logger.log(`${sym.success} ${packageName}` + chalk.gray(` (${duration})`));
    this.logger.log('');
  }

  packageFail(packageName: string, error?: string): void {
    const suffix = error ? ` — ${error}` : '';
    this.logger.log(`${sym.fail} ${chalk.red(packageName)}${suffix}`);
    this.logger.log('');
  }

  packageSkip(packageName: string, reason: string): void {
    this.logger.log(`${sym.skip} ${packageName}` + chalk.gray(` (${reason})`));
    this.logger.log('');
  }

  packageStart(packageName: string): void {
    this.logger.log(chalk.bold(packageName));
  }

  start(title: string, packages: string[]): void {
    const pkgText = packages.length === 1 ? 'package' : 'packages';
    this.logger.log(chalk.bold(`${title} — ${packages.length} ${pkgText}`));
    this.logger.log('');
  }

  subtaskComplete(packageName: string, phase: string, detail?: string): void {
    this.logger.log(`  ${sym.success} ${detail ?? phase}`);
  }

  subtaskSkip(packageName: string, phase: string): void {
    this.logger.log(`  ${sym.skip} ${phase}` + chalk.gray(' (skipped)'));
  }

  subtaskStart(packageName: string, phase: string): void {
    this.logger.log(`  ${sym.progress} ${chalk.dim(phase + '...')}`);
  }

  subtaskUpdate(packageName: string, phase: string, status: string): void {
    this.logger.log(`  ${sym.progress} ${chalk.dim(`${phase}: ${status}`)}`);
  }

  warn(message: string): void {
    this.logger.log(`  ${sym.warn} ${message}`);
  }
}
