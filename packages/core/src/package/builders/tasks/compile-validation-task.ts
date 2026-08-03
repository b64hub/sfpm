import type {LocalValidator, ValidationResult} from '../../../types/local-validator.js';
import type {BuildTask, BuildTaskContext} from '../builder-registry.js';

import {BuildError} from '../../../types/errors.js';
import {SfpmMetadataPackage} from '../../sfpm-package.js';

export interface CompileValidationOptions {
  validator: LocalValidator;
  /**
   * When true (default), compile failures are logged as warnings rather than
   * failing the build. Set to false to make compile errors a hard build failure.
   */
  warnOnly?: boolean;
}

/**
 * Pre-build task that compile-checks a package's Apex via {@link LocalValidator.compile}.
 *
 * Best-effort by design: compile errors are logged as warnings unless `warnOnly`
 * is explicitly set to false. Individual diagnostics are always logged so the
 * presentation layer has full detail, regardless of whether the build fails.
 *
 * Skips silently when the package has no Apex.
 */
class CompileValidationTask implements BuildTask {
  public readonly name = 'compile-validation';
  private readonly ctx: BuildTaskContext;
  private readonly options: CompileValidationOptions;

  constructor(ctx: BuildTaskContext, options: CompileValidationOptions) {
    this.ctx = ctx;
    this.options = options;
  }

  canRun(): boolean {
    return this.ctx.sfpmPackage instanceof SfpmMetadataPackage && this.ctx.sfpmPackage.hasApex;
  }

  async exec(): Promise<void> {
    const {validator, warnOnly = true} = this.options;
    const packageId = this.ctx.sfpmPackage.packageName;
    const projectRoot = this.ctx.provider.projectDir;
    const packagePath = this.ctx.provider.getPackageBuildDirectory(packageId) ?? projectRoot;

    const result = await validator.compile({packageId, packagePath, projectRoot});

    this.logDiagnostics(packageId, result);

    if (result.status === 'passed' || result.status === 'skipped') return;

    const message = `Compile validation ${result.status} for '${packageId}' — ${result.diagnostics.length} diagnostic(s)`;

    if (warnOnly) {
      this.ctx.logger?.warn(message);
      return;
    }

    throw new BuildError(packageId, message, {buildStep: this.name});
  }

  private logDiagnostics(packageId: string, result: ValidationResult): void {
    for (const d of result.diagnostics) {
      const location = d.filePath
        ? ` ${d.filePath}${d.line === undefined ? '' : `:${d.line}`}`
        : '';
      const msg = `[${packageId}]${location} ${d.message}`;
      if (d.severity === 'error') {
        this.ctx.logger?.error(msg);
      } else if (d.severity === 'warning') {
        this.ctx.logger?.warn(msg);
      } else {
        this.ctx.logger?.info(msg);
      }
    }
  }
}

/**
 * Factory that creates a {@link CompileValidationTask}.
 * Follows the curried factory pattern for build tasks.
 */
export function compileValidationTask(options: CompileValidationOptions): (ctx: BuildTaskContext) => BuildTask {
  return (ctx: BuildTaskContext) => new CompileValidationTask(ctx, options);
}
