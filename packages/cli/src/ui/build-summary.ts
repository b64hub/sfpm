import chalk from 'chalk';

import type {OutputLogger} from './renderer-utils.js';

import {formatDuration} from './renderer-utils.js';

export interface BuildSummaryResult {
  failed: boolean;
  packageName: string;
  skipped: boolean;
}

/**
 * Render a single summary line after a build orchestration completes.
 *
 * Examples:
 * - `Build complete — 3 succeeded (12s)`
 * - `Build complete — 2 succeeded, 1 failed (12s)`
 * - `Build complete — 1 succeeded, 1 failed, 1 skipped (12s)`
 */
export function renderBuildSummary(
  results: BuildSummaryResult[],
  totalDurationMs: number,
  logger: OutputLogger,
): void {
  const succeeded = results.filter(r => !r.failed && !r.skipped).length;
  const failed = results.filter(r => r.failed).length;
  const skipped = results.filter(r => r.skipped).length;
  const duration = formatDuration(totalDurationMs);

  const parts: string[] = [];
  if (succeeded > 0) parts.push(chalk.green(`${succeeded} succeeded`));
  if (failed > 0) parts.push(chalk.red(`${failed} failed`));
  if (skipped > 0) parts.push(chalk.yellow(`${skipped} skipped`));

  const summary = parts.join(chalk.dim(', '));
  logger.log(`\n${chalk.bold('Build complete')} ${chalk.dim('—')} ${summary} ${chalk.dim(`(${duration})`)}`);
}
