import type {BoundaryViolation, DependencyResult, LocalValidator} from '../../../types/local-validator.js';
import type {BuildTask, BuildTaskContext} from '../builder-registry.js';

import {BuildError} from '../../../types/errors.js';

export interface DependencyAnalysisOptions {
  validator: LocalValidator;
  warnOnly?: boolean;
}

/**
 * Pre-build task that validates declared package dependencies against
 * actual metadata references using {@link LocalValidator.checkDependencies}.
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
    const {validator, warnOnly} = this.options;
    const packageId = this.ctx.sfpmPackage.packageName;

    const projectRoot = this.ctx.provider.projectDir;
    const result = await validator.checkDependencies({
      packageId,
      packagePath: this.ctx.provider.getPackageBuildDirectory(packageId) ?? projectRoot,
      projectRoot,
    });

    if (result.status === 'skipped') {
      this.ctx.logger?.info(`Dependency check skipped for ${packageId}`);
      return;
    }

    if (result.status === 'error') {
      throw new BuildError(packageId, `Dependency check errored for ${packageId}`, {
        buildStep: this.name,
      });
    }

    if (result.violations.length === 0) {
      this.ctx.logger?.info(`No boundary violations found for ${packageId}`);
      return;
    }

    const message = this.formatReport(packageId, result);

    if (warnOnly) {
      this.ctx.logger?.warn(message);
      return;
    }

    throw new BuildError(packageId, message, {buildStep: this.name});
  }

  private formatReport(packageId: string, result: DependencyResult): string {
    const lines: string[] = [`Package '${packageId}' has undeclared dependencies:`];

    const byPackage: Record<string, BoundaryViolation[]> = {};
    for (const v of result.violations) {
      (byPackage[v.toPackage] ??= []).push(v);
    }

    for (const [pkg, violations] of Object.entries(byPackage)) {
      lines.push(`  → ${pkg} (${violations.length} violation(s))`);
      for (const v of violations) {
        lines.push(`      ${v.fromMetadata} → ${v.toMetadata}`);
      }
    }

    if (result.unresolved.length > 0) {
      lines.push(`  (${result.unresolved.length} unresolved reference(s) not in ownership index)`);
    }

    return lines.join('\n');
  }
}

/**
 * Factory that creates a {@link DependencyAnalysisTask}.
 * Follows the curried factory pattern for build tasks.
 */
export function dependencyAnalysisTask(options: DependencyAnalysisOptions): (ctx: BuildTaskContext) => BuildTask {
  return (ctx: BuildTaskContext) => new DependencyAnalysisTask(ctx, options);
}
