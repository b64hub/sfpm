import {Org} from '@salesforce/core';
import {ComponentSet} from '@salesforce/source-deploy-retrieve';

import type {ProjectDefinitionProvider} from '../project/providers/project-definition-provider.js';
import type {HookContext, HookTiming} from '../types/lifecycle.js';
import type {LocalValidator} from '../types/local-validator.js';
import type {PendingValidationDescriptor, ValidationLevel} from '../types/validation.js';

import {ArtifactRepository} from '../artifacts/artifact-repository.js';
import {BuildEventBus, BuildEventSink} from '../events/build-event-bus.js';
import {extractErrorDetails} from '../events/orchestration-event-bus.js';
import LifecycleEngine from '../lifecycle/lifecycle-engine.js';
import {BuildError} from '../types/errors.js';
import Logger from '../types/logger.js';
import {BuildOptions, type BuildOrg, PackageType} from '../types/package.js';
import {getPipelineRunId} from '../utils/pipeline.js';
import {SourceHasher} from '../utils/source-hasher.js';
import {AnalyzerRegistry, PackageAnalyzer} from './analyzers/analyzer-registry.js';
import PackageAssembler from './assemblers/package-assembler.js';
import {
  Builder, builderFactory, BuilderResult,
  BuildTaskContext, BuildTaskResult,
} from './builders/builder-registry.js';
import {compileValidationTask} from './builders/tasks/compile-validation-task.js';
import {dependencyAnalysisTask} from './builders/tasks/dependency-analysis-task.js';
import SfpmPackage, {PackageFactory, SfpmMetadataPackage} from './sfpm-package.js';

/**
 * Internal configuration resolved from {@link ValidationLevel}.
 */
interface ModeConfig {
  /** Whether and how to run dependency analysis (cross-package reference validation) */
  dependencyAnalysis: 'error' | 'warn' | false;
  /**
   * Whether to run local compile validation. Always warn-only (best-effort) —
   * the org is the authoritative compiler. Skipped when orgValidation handles it.
   */
  localCompile: boolean;
  /** Whether to connect to and validate against an org */
  orgValidation: boolean;
}

const VALIDATION_CONFIGS: Record<ValidationLevel, ModeConfig> = {
  full: {
    dependencyAnalysis: 'error',
    localCompile: true,   // best-effort compile check; org is authoritative
    orgValidation: true,
  },
  local: {
    dependencyAnalysis: 'warn',
    localCompile: true,   // sole compile signal when no org
    orgValidation: false,
  },
  none: {
    dependencyAnalysis: false,
    localCompile: false,
    orgValidation: false,
  },
  org: {
    dependencyAnalysis: 'warn',
    localCompile: false,  // org compiler is authoritative; skip local check
    orgValidation: true,
  },
};

function resolveModeConfig(validation?: ValidationLevel): ModeConfig {
  return VALIDATION_CONFIGS[validation ?? 'full'];
}

/**
 * Result of a single {@link PackageBuilder.build} call.
 *
 * `skipped` is always explicit here rather than inferred from `pendingValidation`
 * being absent — a successful build with no pending validation (e.g. a plain
 * source package) also has no `pendingValidation`, so the two cases are not
 * distinguishable by presence/absence alone.
 */
export interface PackageBuildResult {
  pendingValidation?: PendingValidationDescriptor;
  skipped: boolean;
  skipReason?: 'empty-package' | 'no-changes';
}

/**
 * Orchestrator for package builds.
 *
 * Manages the full build lifecycle:
 * 1. Stage package content to `./dist`
 * 2. Check if build is needed (source hash comparison)
 * 3. Run analyzers
 * 4. Run pre-build hooks
 * 5. Execute the builder (via {@link builderFactory})
 * 6. Run post-build hooks
 *
 * Holds no per-call mutable state — safe to construct once and reuse across
 * concurrent {@link build} calls for different packages. Each call computes
 * its own child logger, event sink, and effective options locally and
 * threads them through explicitly, rather than storing them on the instance.
 */
export {PackageBuilder};
export default class PackageBuilder {
  private buildOrg?: BuildOrg;
  private bus?: BuildEventBus;
  private localValidator?: LocalValidator;
  private options: BuildOptions;
  private provider: ProjectDefinitionProvider;
  private readonly rootLogger?: Logger;

  constructor(
    provider: ProjectDefinitionProvider,
    buildOrg?: BuildOrg,
    options?: BuildOptions,
    logger?: Logger,
    localValidator?: LocalValidator,
    bus?: BuildEventBus,
  ) {
    this.buildOrg = buildOrg;
    this.bus = bus;
    this.localValidator = localValidator;
    this.rootLogger = logger;
    this.options = options || {};
    this.provider = provider;
  }

  /**
   * Build a single package by name.
   */
  public async build(packageName: string): Promise<PackageBuildResult> {
    return this.execute(packageName);
  }

  public async dryRun(packageName: string): Promise<PackageBuildResult> {
    return this.execute(packageName, {validation: 'local'});
  }

  public async runAnalyzer(sfpmPackage: SfpmPackage, analyzer: PackageAnalyzer, sink?: BuildEventSink): Promise<{name: string; success: boolean}> {
    const analyzerName = analyzer.name;

    sink?.analyzerStart({
      analyzerName,
    });

    try {
      const metadataContribution = await analyzer.analyze(sfpmPackage);
      if (sfpmPackage instanceof SfpmMetadataPackage) {
        sfpmPackage.updateContent(metadataContribution);
      }

      sink?.analyzerComplete({
        analyzerName,
      });

      return {name: analyzerName, success: true};
    } catch (error) {
      sink?.analyzerComplete({
        analyzerName,
        error: error instanceof Error ? error.message : String(error),
      });

      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`[${analyzerName}] ${message}`, {cause: error});
    }
  }

  public async runAnalyzers(sfpmPackage: SfpmPackage, logger?: Logger, sink?: BuildEventSink): Promise<void> {
    if (sfpmPackage.type === PackageType.Data) {
      return;
    }

    const analyzers = AnalyzerRegistry.getAnalyzers(logger);
    const enabledAnalyzers = analyzers.filter(a => a.isEnabled(sfpmPackage));

    sink?.analyzersStart({
      analyzerCount: enabledAnalyzers.length,
    });

    try {
      await Promise.all(enabledAnalyzers.map(async analyzer => this.runAnalyzer(sfpmPackage, analyzer, sink)));

      // Mark analyzed so ensureAnalyzed() is a no-op for deploy/install paths
      if (sfpmPackage instanceof SfpmMetadataPackage) {
        sfpmPackage.markAnalyzed();
      }

      sink?.analyzersComplete({
        completedCount: enabledAnalyzers.length,
      });
    } catch (error: any) {
      sink?.error({
        error,
        phase: 'analysis',
      });
      // One log line per item when the failure has a structured breakdown —
      // grep-able individually, instead of one giant joined-string entry.
      for (const detail of extractErrorDetails(error) ?? []) {
        logger?.error(`${detail.label}: ${detail.message}`);
      }

      // Single choke point: every error escaping build() is guaranteed to be
      // a BuildError from here on — the original is preserved as `.cause`
      // (extractErrorDetails looks there).
      if (error instanceof BuildError) throw error;
      throw new BuildError(
        sfpmPackage.name,
        error instanceof Error ? error.message : String(error),
        {buildStep: 'analysis', cause: error instanceof Error ? error : new Error(String(error))},
      );
    }
  }

  // ========================================================================
  // Private — Build Pipeline
  // ========================================================================

  /**
   * Apply builder result to the package domain model.
   */
  private applyBuilderResult(sfpmPackage: SfpmPackage, result: BuilderResult): void {
    if (result.packageType) {
      sfpmPackage.type = result.packageType;
    }

    if (result.version) {
      sfpmPackage.version = result.version;
    }

    if (result.packageVersionId && 'packageVersionId' in sfpmPackage) {
      (sfpmPackage as any).packageVersionId = result.packageVersionId;
    }
  }

  /** Apply task enrichments to the package. */
  private applyEnrichments(sfpmPackage: SfpmPackage, enrichments: NonNullable<BuildTaskResult['enrichments']>): void {
    if (enrichments.testCoverage !== undefined && 'testCoverage' in sfpmPackage) {
      (sfpmPackage as SfpmMetadataPackage).testCoverage = enrichments.testCoverage;
    }
  }

  /**
   * Compare the current source hash against the previous build's dist/package.json.
   * Returns match info if hashes are equal, undefined otherwise.
   */
  private async checkSourceHash(
    sfpmPackage: SfpmMetadataPackage,
    repo: ArtifactRepository,
    logger?: Logger,
  ): Promise<undefined | {artifactPath?: string; latestVersion?: string}> {
    const currentSourceHash = await SourceHasher.calculate(sfpmPackage);
    logger?.debug(`Source hash: ${currentSourceHash}`);

    const match = await repo.checkSourceHash(currentSourceHash);
    if (!match) {
      logger?.info('Source changes detected, proceeding with build');
    }

    return match;
  }

  /**
   * Compute the effective (possibly overridden) options for a build call,
   * compute the per-package child logger, and run the pipeline. Neither the
   * override nor the child logger are ever written back onto the instance —
   * this keeps the instance safe to reuse across concurrent builds.
   */
  private async execute(packageName: string, optionsOverride?: Partial<BuildOptions>): Promise<PackageBuildResult> {
    const options: BuildOptions = optionsOverride ? {...this.options, ...optionsOverride} : this.options;
    const logger = this.rootLogger?.child?.({package: packageName}) ?? this.rootLogger;

    const packageFactory = new PackageFactory(this.provider);
    const sfpmPackage = packageFactory.createFromName(packageName);

    const sink = this.bus?.forPackage(sfpmPackage.name);

    sink?.start({
      buildNumber: options.buildNumber,
      packageType: sfpmPackage.type as PackageType,
      version: sfpmPackage.version,
    });

    this.handleBuildConfiguration(sfpmPackage, options, logger);

    return this.runBuilder(sfpmPackage, options, logger, sink);
  }

  /**
   * Merge package definition build options and assign build number.
   */
  private handleBuildConfiguration(sfpmPackage: SfpmPackage, options: BuildOptions, logger?: Logger): void {
    if (options.buildNumber) {
      sfpmPackage.setBuildNumber(options.buildNumber);
    } else if (sfpmPackage.type !== PackageType.Unlocked) {
      const autoBuildNumber = getPipelineRunId() ?? String(Math.floor(Date.now() / 1000));
      sfpmPackage.setBuildNumber(autoBuildNumber);
      logger?.debug(`Auto-assigned build number ${autoBuildNumber} for ${sfpmPackage.name}`);
    }
  }

  /**
   * Check whether the existing build output satisfies the current build's requirements.
   *
   * An unlocked package with org/full validation (not source-only) requires a
   * packageVersionId in dist/package.json. A previous --source-only or --validation=local
   * build won't have one, so a rebuild is needed despite matching source hash.
   */
  private async manifestSatisfiesBuild(
    sfpmPackage: SfpmPackage,
    repo: ArtifactRepository,
    options: BuildOptions,
    logger?: Logger,
  ): Promise<boolean> {
    const needsPackageVersionId = sfpmPackage.type === PackageType.Unlocked
      && !options.unlocked?.sourceOnly
      && (options.validation === 'org' || options.validation === 'full' || !options.validation);

    if (!needsPackageVersionId) return true;

    const packageVersionId = repo.getPackageVersionId();
    if (!packageVersionId) {
      logger?.info(`Build required for '${sfpmPackage.packageName}': existing build has no packageVersionId`);
      return false;
    }

    return true;
  }

  /**
   * Determine whether a build is needed for this package.
   *
   * Checks two conditions:
   * 1. Source hash — has the source changed since the last build?
   * 2. Build completeness — does the existing build output satisfy
   *    the current build's requirements (e.g., packageVersionId for
   *    unlocked packages with org validation)?
   *
   * Returns skip info when the build can be skipped, or undefined to proceed.
   */
  private async needsBuild(
    sfpmPackage: SfpmPackage,
    options: BuildOptions,
    logger?: Logger,
  ): Promise<undefined | {artifactPath?: string; latestVersion?: string}> {
    if (!(sfpmPackage instanceof SfpmMetadataPackage)) {
      return undefined;
    }

    const sourcePath = sfpmPackage.packageDefinition?.path;
    if (!sourcePath) {
      logger?.info('No package definition path, proceeding with build');
      return undefined;
    }

    const packageWorkspacePath = this.provider.getPackageDir(sfpmPackage.name);
    if (!packageWorkspacePath) {
      logger?.info('Could not resolve package workspace path, proceeding with build');
      return undefined;
    }

    const repo = new ArtifactRepository(packageWorkspacePath, logger);

    // 1. Check source hash
    const hashMatch = await this.checkSourceHash(sfpmPackage, repo, logger);
    if (!hashMatch) return undefined;

    // 2. Check build completeness
    if (!await this.manifestSatisfiesBuild(sfpmPackage, repo, options, logger)) return undefined;

    logger?.info(`Build skipped for '${sfpmPackage.packageName}': no source changes detected. `
      + `Latest version: ${hashMatch.latestVersion}`);
    return hashMatch;
  }

  /**
   * Route unlocked packages through source builder when:
   * no org validation (local/none), or
   * --source-only mode (PR validation without DevHub)
   * @param sfpmPackage
   * @param modeConfig
   * @param options
   */
  private resolveBuildAs(sfpmPackage: SfpmPackage, modeConfig: ModeConfig, options: BuildOptions): PackageType | undefined {
    if (sfpmPackage.type !== PackageType.Unlocked) return undefined;
    if (options.unlocked?.sourceOnly) return PackageType.Source;
    if (!modeConfig.orgValidation) return PackageType.Source;
    return undefined;
  }

  /**
   * Resolve the target org for the builder based on package type.
   * Returns undefined when org validation is disabled.
   */
  private resolveTargetOrg(sfpmPackage: SfpmPackage, modeConfig: ModeConfig, options: BuildOptions): Org | undefined {
    if (!modeConfig.orgValidation) return undefined;

    // Unlocked packages use the DevHub (unless sourceOnly, which uses buildOrg)
    if (sfpmPackage.type === PackageType.Unlocked && !options.unlocked?.sourceOnly) {
      return this.buildOrg?.devhub;
    }

    return this.buildOrg?.buildOrg;
  }

  /**
   * Unified build flow: stage → check → analyze → hooks → build → hooks.
   */
  private async runBuilder(
    sfpmPackage: SfpmPackage,
    options: BuildOptions,
    logger?: Logger,
    sink?: BuildEventSink,
  ): Promise<PackageBuildResult> {
    const componentCount = await this.stagePackage(sfpmPackage, logger, sink);

    if (componentCount === 0) {
      sink?.skip({
        packageType: sfpmPackage.type as PackageType,
        reason: 'empty-package',
        version: sfpmPackage.version,
      });
      return {skipped: true, skipReason: 'empty-package'};
    }

    // Check if build is needed (source hash comparison)
    if (!options.force) {
      const skip = await this.needsBuild(sfpmPackage, options, logger);
      if (skip) {
        sink?.skip({
          artifactPath: skip.artifactPath,
          latestVersion: skip.latestVersion,
          packageType: sfpmPackage.type as PackageType,
          reason: 'no-changes',
          version: sfpmPackage.version,
        });
        return {skipped: true, skipReason: 'no-changes'};
      }
    }

    const modeConfig = resolveModeConfig(options.validation);

    // Content analyzers always run — they enrich the package model
    // with data needed for deployment (test classes, FHT fields, etc.)
    await this.runAnalyzers(sfpmPackage, logger, sink);

    // Run pre-build hooks after analyzers have enriched the package context
    await this.runLifecycleHooks('pre', sfpmPackage, logger, sink);

    const buildAs = this.resolveBuildAs(sfpmPackage, modeConfig, options);

    const builderInstance = builderFactory(this.provider, sfpmPackage, options, logger, sink, buildAs as PackageType);

    // Register local compile check as a pre-build task (best-effort, always warn-only)
    if (this.localValidator && modeConfig.localCompile) {
      builderInstance.tasks.push({
        factory: compileValidationTask({
          validator: this.localValidator,
          warnOnly: true,
        }),
        phase: 'pre',
      });
    }

    // Register dependency analysis as a pre-build task
    if (this.localValidator && modeConfig.dependencyAnalysis) {
      builderInstance.tasks.push({
        factory: dependencyAnalysisTask({
          validator: this.localValidator,
          warnOnly: modeConfig.dependencyAnalysis === 'warn',
        }),
        phase: 'pre',
      });
    }

    // Connect to org if needed
    const targetOrg = this.resolveTargetOrg(sfpmPackage, modeConfig, options);
    if (targetOrg) {
      await builderInstance.connect(targetOrg);
    }

    sink?.builderStart({
      builderName: builderInstance.constructor.name,
      packageType: sfpmPackage.type as PackageType,
    });

    try {
      // Run pre-build tasks
      await this.runTasks(sfpmPackage, builderInstance, 'pre', logger, sink);

      // Execute the builder
      const result = await builderInstance.exec();

      // Apply result to package
      this.applyBuilderResult(sfpmPackage, result);

      if (result.pendingValidation) {
        const pv = result.pendingValidation;
        sink?.validateQueued({
          operationId: pv.operationType === 'package-version-request'
            ? pv.packageVersionRequestId
            : pv.packageName,
          operationType: pv.operationType,
        });
      }

      // Run post-build tasks
      await this.runTasks(sfpmPackage, builderInstance, 'post', logger, sink);

      sink?.builderComplete({
        builderName: builderInstance.constructor.name,
        componentCount,
        packageType: sfpmPackage.type as PackageType,
      });

      // Run post-build hooks
      await this.runLifecycleHooks('post', sfpmPackage, logger, sink);

      sink?.complete({
        packageVersionId: result.packageVersionId,
        success: true,
      });

      return {pendingValidation: result.pendingValidation, skipped: false};
    } catch (error: any) {
      sink?.error({
        error,
        phase: 'build',
      });
      for (const detail of extractErrorDetails(error) ?? []) {
        logger?.error(`${detail.label}: ${detail.message}`);
      }

      if (error instanceof BuildError) throw error;
      throw new BuildError(
        sfpmPackage.name,
        error instanceof Error ? error.message : String(error),
        {buildStep: 'build', cause: error instanceof Error ? error : new Error(String(error))},
      );
    }
  }

  /**
   * Run lifecycle hooks for the build operation.
   */
  private async runLifecycleHooks(
    timing: HookTiming,
    sfpmPackage: SfpmPackage,
    logger?: Logger,
    sink?: BuildEventSink,
  ): Promise<void> {
    if (!LifecycleEngine.isInitialized()) return;

    const lifecycle = LifecycleEngine.getInstance();
    const hookContext: HookContext = {
      logger,
      operation: 'build',
      projectDir: this.provider.projectDir,
      provider: this.provider,
      sfpmPackage,
      stage: lifecycle.stage,
      targetOrg: this.buildOrg?.devhub?.getUsername() ?? this.buildOrg?.buildOrg?.getUsername(),
      timing,
    };

    if (timing === 'pre') {
      await lifecycle.runBuildPre(hookContext, sink);
    } else {
      await lifecycle.runBuildPost(hookContext, sink);
    }
  }

  /**
   * Run task registrations sequentially, emitting lifecycle events.
   */
  private async runTasks(
    sfpmPackage: SfpmPackage,
    builderInstance: Builder,
    phase: 'post' | 'pre',
    logger?: Logger,
    sink?: BuildEventSink,
  ): Promise<void> {
    const registrations = builderInstance.tasks.filter(t => t.phase === phase);
    const taskType = `${phase}-build` as 'post-build' | 'pre-build';

    const ctx: BuildTaskContext = {
      logger,
      provider: this.provider,
      sfpmPackage,
      sink,
    };

    for (const registration of registrations) {
      const task = registration.factory(ctx);
      const taskName = task.name;

      // Check runtime precondition
      if (task.canRun && !task.canRun()) {
        sink?.taskSkip({
          reason: `Precondition not met for task '${taskName}'`,
          taskName,
          taskType,
        });
        continue;
      }

      sink?.taskStart({
        taskName,
        taskType,
      });

      try {
        // eslint-disable-next-line no-await-in-loop -- tasks run sequentially, stop on first failure
        const result = await task.exec();

        if (result?.enrichments) {
          this.applyEnrichments(sfpmPackage, result.enrichments);
        }

        sink?.taskComplete({
          success: true,
          taskName,
          taskType,
          warnings: result?.warnings,
        });
      } catch (error) {
        sink?.taskComplete({
          success: false,
          taskName,
          taskType,
        });

        throw error;
      }
    }
  }

  private async stagePackage(sfpmPackage: SfpmPackage, logger?: Logger, sink?: BuildEventSink): Promise<number> {
    sink?.stageStart({
      stagingDirectory: this.provider.getPackageBuildDirectory(sfpmPackage.name),
    });

    try {
      const assemblyOutput = await new PackageAssembler(
        sfpmPackage.name,
        this.provider,
        {
          versionNumber: sfpmPackage.version,
        },
        logger,
      ).assemble();

      // Initialise the ComponentSet from staged source so the package model
      // never needs to know about the staging directory itself.
      if (sfpmPackage instanceof SfpmMetadataPackage) {
        const stagedSourcePath = this.provider.getPackageBuiltSourceDirectory(sfpmPackage.name);
        if (stagedSourcePath) {
          sfpmPackage.setComponentSet(ComponentSet.fromSource(stagedSourcePath));
        }
      }

      sink?.stageComplete({
        componentCount: assemblyOutput.componentCount || 0,
        stagingDirectory: assemblyOutput.stagingDirectory,
      });

      return assemblyOutput.componentCount || 0;
    } catch (error: any) {
      sink?.error({
        error,
        phase: 'staging',
      });
      for (const detail of extractErrorDetails(error) ?? []) {
        logger?.error(`${detail.label}: ${detail.message}`);
      }

      if (error instanceof BuildError) throw error;
      throw new BuildError(
        sfpmPackage.name,
        error instanceof Error ? error.message : String(error),
        {buildStep: 'staging', cause: error instanceof Error ? error : new Error(String(error))},
      );
    }
  }
}
