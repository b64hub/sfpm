import type {DependencyAnalyzer, DependencyReport} from '../../../types/dependency-analysis.js';
import type {BuildTask, BuildTaskContext} from '../builder-registry.js';

import {BuildError} from '../../../types/errors.js';

export interface DependencyAnalysisOptions {
  analyzer: DependencyAnalyzer;
  warnOnly?: boolean;
}

/**
 * Pre-build task that validates declared dependencies against
 * actual metadata references using a pluggable DependencyAnalyzer.
 *
 * When `warnOnly` is true, violations are logged but don't fail the build.
 */
class DependencyAnalysisTask implements BuildTask {
  public readonly name = 'dependency-analysis';
  private readonly ctx: BuildTaskContext;
  private readonly options: DependencyAnalysisOptions;

  public constructor(ctx: BuildTaskContext, options: DependencyAnalysisOptions) {
    this.ctx = ctx;
    this.options = options;
  }

  public async exec(): Promise<void> {
    const {analyzer, warnOnly} = this.options;
    const report = await analyzer.analyze(this.ctx.sfpmPackage);

    if (report.missingDependencies.length === 0) {
      this.ctx.logger?.info(`No missing dependencies found for ${report.packageName}`);
      return;
    }

    const message = this.formatReport(report);

    if (warnOnly) {
      this.ctx.logger?.warn(message);
      return;
    }

    throw new BuildError(report.packageName, message, {
      buildStep: this.name,
    });
  }

  private formatReport(report: DependencyReport): string {
    const lines: string[] = [
      `Package '${report.packageName}' has undeclared dependencies:`,
    ];

    for (const dep of report.missingDependencies) {
      lines.push(`  → ${dep.packageName} (referenced by ${dep.references.length} symbol(s))`);
      for (const ref of dep.references) {
        lines.push(`      ${ref.symbol} in ${ref.sourceFile}`);
      }
    }

    return lines.join('\n');
  }
}

/**
 * Factory that creates a DependencyAnalysisTask.
 * Follows the same pattern as other task factories (e.g., `sourceHashTask()`).
 */
export function dependencyAnalysisTask(options: DependencyAnalysisOptions): (ctx: BuildTaskContext) => BuildTask {
  return (ctx: BuildTaskContext) => new DependencyAnalysisTask(ctx, options);
}
