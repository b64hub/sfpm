import {Org} from '@salesforce/core';
import {merge} from 'lodash-es';

import type {ProjectDefinitionProvider} from '../project/providers/project-definition-provider.js';

import {ArtifactRepository} from '../artifacts/artifact-repository.js';
import {BuildEventBus, BuildEventSink} from '../events/build-event-bus.js';
import {LifecycleEngine} from '../lifecycle/lifecycle-engine.js';
import {IgnoreFilesConfig} from '../types/config.js';
import {HookContext, HookTiming} from '../types/lifecycle.js';
import {Logger} from '../types/logger.js';
import {PackageType, PendingValidationDescriptor} from '../types/package.js';
import {getPipelineRunId} from '../utils/pipeline.js';
import {SourceHasher} from '../utils/source-hasher.js';
import {resolvePackageWorkspacePath} from '../utils/workspace-path.js';
import {AnalyzerRegistry, PackageAnalyzer} from './analyzers/analyzer-registry.js';
import PackageAssembler from './assemblers/package-assembler.js';
import {
  builderFactory, BuilderOptions, BuilderResult,
  BuildTaskContext, BuildTaskRegistration, BuildTaskResult,
} from './builders/builder-registry.js';
import SfpmPackage, {PackageFactory, SfpmMetadataPackage} from './sfpm-package.js';

export type BuildMode = 'default' | 'dry-run';

/**
 * Internal configuration resolved from {@link BuildMode}.
 * Maps a mode to the set of features and behaviors it enables.
 * Consumers should never construct this directly — use `resolveModeConfig()`.
 */
interface ModeConfig {
  /** Whether to always produce an artifact (false = skip artifact in dry-run CLI) */
  artifact: boolean;
  /** How dependency analysis should behave: 'warn' = log violations, 'error' = throw, 'skip' = don't run */
  dependencyAnalysis: 'error' | 'skip' | 'warn';
  /** Whether to run validation */
  validation: 'local' | boolean;
}

const MODE_DEFAULTS: Record<BuildMode, ModeConfig> = {
  default: {
    artifact: true,
    dependencyAnalysis: 'warn',
    validation: true,
  },
  'dry-run': {
    artifact: false,
    dependencyAnalysis: 'error',
    validation: 'local',
  },
};

function resolveModeConfig(mode?: BuildMode, skipValidation?: boolean): ModeConfig {
  const base = MODE_DEFAULTS[mode ?? 'default'];
  if (skipValidation) {
    return {...base, dependencyAnalysis: 'skip', validation: false};
  }

  return base;
}

/**
 * Options for {@link PackageBuilder.runBuilder}.
 */
interface RunBuilderOptions {
  /** Build even if source hash matches a previous build. */
  force: boolean;
}

export interface BuildOptions {
  /** Build number for version generation */
  buildNumber?: string;
  /** Target org for source package validation (deploy + test). Required for `dry-run` mode. */
  buildOrg?: string;
  /** DevHub username or alias for unlocked package builds */
  devhubUsername?: string;
  /** Force build even if no source changes detected (skip hash check) */
  force?: boolean;
  /** Installation key for unlocked packages */
  installationKey?: string;
  /**
   * Build mode. Determines which builder pipeline, validation, and feature flags apply.
   *
   * - `default` — production-ready artifact with full validation.
   *   Source packages: deploy+test against buildOrg. Unlocked: SF API with async validation + code coverage.
   * - `dry-run` — maximum validation, no real SF API build, no artifacts.
   *   All packages go through the source pipeline with deploy+test.
   */
  mode?: BuildMode;
  /**
   * Skip validation entirely. Acts as an overlay on the active mode:
   * forces `validation: false` and `dependencyAnalysis: 'skip'`.
   *
   * Combine with `mode: 'default'` for a fast build without quality gates.
   * Combine with `mode: 'dry-run'` for a pure artifact-only assembly (no tags, no validation).
   */
  skipValidation?: boolean;
  /** Timeout in minutes for package version creation (default: 120) */
  waitTime?: number;
}

/**
 * Orchestrator for package builds.
 *
 * Manages the full build lifecycle:
 * 1. Stage package content to `artifacts/package/`
 * 2. Check if build is needed (source hash comparison)
 * 3. Run analyzers
 * 4. Run pre-build hooks
 * 5. Execute the builder (via {@link builderFactory})
 * 6. Run post-build hooks
 */
export class PackageBuilder {
  private bus?: BuildEventBus;
  private ignoreFilesConfig?: IgnoreFilesConfig;
  private logger: Logger | undefined;
  private options: BuildOptions;
  private provider: ProjectDefinitionProvider;
  private sink?: BuildEventSink;

  constructor(
    provider: ProjectDefinitionProvider,
    options?: BuildOptions,
    logger?: Logger,
    ignoreFilesConfig?: IgnoreFilesConfig,
    bus?: BuildEventBus,
  ) {
    this.options = options || {};
    this.logger = logger;
    this.provider = provider;
    this.ignoreFilesConfig = ignoreFilesConfig;
    this.bus = bus;
  }

  /**
   * Build a single package by name.
   */
  public async build(packageName: string): Promise<PendingValidationDescriptor | undefined> {
    const packageFactory = new PackageFactory(this.provider);
    const sfpmPackage = packageFactory.createFromName(packageName);

    this.sink = this.bus?.forPackage(sfpmPackage.name);

    this.sink?.start({
      buildNumber: this.options.buildNumber,
      packageType: sfpmPackage.type as PackageType,
      version: sfpmPackage.version,
    });

    this.handleBuildConfiguration(sfpmPackage);

    return this.runBuilder(sfpmPackage, {force: this.options.force ?? false});
  }

  public async dryRun(packageName: string): Promise<PendingValidationDescriptor | undefined> {
    this.options.mode = 'dry-run';
    return this.build(packageName);
  }

  public async runAnalyzer(sfpmPackage: SfpmPackage, analyzer: PackageAnalyzer): Promise<{name: string; success: boolean}> {
    const analyzerName = analyzer.name;

    this.sink?.analyzerStart({
      analyzerName,
    });

    try {
      const metadataContribution = await analyzer.analyze(sfpmPackage);
      merge(sfpmPackage.metadata, metadataContribution);

      this.sink?.analyzerComplete({
        analyzerName,
      });

      return {name: analyzerName, success: true};
    } catch (error) {
      this.sink?.analyzerComplete({
        analyzerName,
        error: error instanceof Error ? error.message : String(error),
      });

      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`[${analyzerName}] ${message}`, {cause: error});
    }
  }

  public async runAnalyzers(sfpmPackage: SfpmPackage): Promise<void> {
    if (sfpmPackage.type === PackageType.Data) {
      return;
    }

    const analyzers = AnalyzerRegistry.getAnalyzers(this.logger);
    const enabledAnalyzers = analyzers.filter(a => a.isEnabled(sfpmPackage));

    this.sink?.analyzersStart({
      analyzerCount: enabledAnalyzers.length,
    });

    try {
      await Promise.all(enabledAnalyzers.map(async analyzer => this.runAnalyzer(sfpmPackage, analyzer)));

      this.sink?.analyzersComplete({
        completedCount: enabledAnalyzers.length,
      });
    } catch (error: any) {
      this.sink?.error({
        error,
        phase: 'analysis',
      });
      throw error;
    }
  }

  // ========================================================================
  // Private — Build Pipeline
  // ========================================================================

  /**
   * Apply builder result to the package domain model.
   */
  private applyBuilderResult(sfpmPackage: SfpmPackage, result: BuilderResult): void {
    if (result.version) {
      sfpmPackage.version = result.version;
    }

    if (result.packageVersionId && 'packageVersionId' in sfpmPackage) {
      (sfpmPackage as any).packageVersionId = result.packageVersionId;
    }

    if (result.validationState && sfpmPackage instanceof SfpmMetadataPackage) {
      sfpmPackage.validationState = result.validationState;
    }
  }

  /** Apply task enrichments to the package. */
  private applyEnrichments(sfpmPackage: SfpmPackage, enrichments: NonNullable<BuildTaskResult['enrichments']>): void {
    if (enrichments.testCoverage !== undefined && 'testCoverage' in sfpmPackage) {
      (sfpmPackage as SfpmMetadataPackage).testCoverage = enrichments.testCoverage;
    }
  }

  /**
   * Source hash guard — determines whether a build is necessary by comparing
   * the current source hash against the latest artifact manifest entry.
   */
  private async checkSourceHash(sfpmPackage: SfpmPackage): Promise<undefined | {artifactPath?: string; latestVersion?: string}> {
    if (!(sfpmPackage instanceof SfpmMetadataPackage)) {
      return undefined;
    }

    const currentSourceHash = await SourceHasher.calculate(sfpmPackage);
    this.logger?.debug(`Source hash: ${currentSourceHash}`);

    const sourcePath = sfpmPackage.packageDefinition?.path;
    if (!sourcePath) {
      this.logger?.info('No package definition path, proceeding with build');
      return undefined;
    }

    let packageWorkspacePath: string;
    try {
      packageWorkspacePath = resolvePackageWorkspacePath(this.provider.projectDir, sourcePath);
    } catch {
      this.logger?.info('Could not resolve package workspace path, proceeding with build');
      return undefined;
    }

    const repo = new ArtifactRepository(packageWorkspacePath, this.logger);
    const match = await repo.checkSourceHash(currentSourceHash);

    if (match) {
      this.logger?.info(`Build skipped for '${sfpmPackage.packageName}': no source changes detected. `
        + `Latest version: ${match.latestVersion}, hash: ${currentSourceHash}`);
      return match;
    }

    this.logger?.info('Source changes detected, proceeding with build');
    return undefined;
  }

  /**
   * Merge package definition build options and assign build number.
   */
  private handleBuildConfiguration(sfpmPackage: SfpmPackage): void {
    if (sfpmPackage.packageDefinition?.packageOptions?.build) {
      merge(sfpmPackage.metadata.orchestration, {
        build: sfpmPackage.packageDefinition.packageOptions.build,
      });
    }

    if (this.options.buildNumber) {
      sfpmPackage.setBuildNumber(this.options.buildNumber);
    } else if (sfpmPackage.type !== PackageType.Unlocked) {
      const autoBuildNumber = getPipelineRunId() ?? String(Math.floor(Date.now() / 1000));
      sfpmPackage.setBuildNumber(autoBuildNumber);
      this.logger?.debug(`Auto-assigned build number ${autoBuildNumber} for ${sfpmPackage.name}`);
    }
  }

  /** Check whether a staged package contains zero deployable components or files. */
  private async isPackageEmpty(sfpmPackage: SfpmPackage): Promise<boolean> {
    return (await sfpmPackage.componentCount()) === 0;
  }

  /**
   * Resolve the target org for the builder based on package type and mode.
   */
  private async resolveTargetOrg(sfpmPackage: SfpmPackage, modeConfig: ModeConfig): Promise<Org | undefined> {
    const packageType = (modeConfig.validation === 'local' && sfpmPackage.type === PackageType.Unlocked)
      ? PackageType.Source
      : sfpmPackage.type;

    let username: string | undefined;
    if (packageType === PackageType.Unlocked) {
      username = this.options.devhubUsername;
    } else {
      username = this.options.buildOrg;
    }

    if (!username) return undefined;

    return Org.create({aliasOrUsername: username});
  }

  /**
   * Unified build flow: stage → check → analyze → hooks → build → hooks.
   */
  private async runBuilder(sfpmPackage: SfpmPackage, options: RunBuilderOptions): Promise<PendingValidationDescriptor | undefined> {
    const componentCount = await this.stagePackage(sfpmPackage);

    if (await this.isPackageEmpty(sfpmPackage)) {
      this.sink?.skip({
        packageType: sfpmPackage.type as PackageType,
        reason: 'empty-package',
        version: sfpmPackage.version,
      });
      return undefined;
    }

    // Check if build is needed (source hash comparison)
    if (!options.force) {
      const hashSkip = await this.checkSourceHash(sfpmPackage);
      if (hashSkip) {
        this.sink?.skip({
          artifactPath: hashSkip.artifactPath,
          latestVersion: hashSkip.latestVersion,
          packageType: sfpmPackage.type as PackageType,
          reason: 'no-changes',
          version: sfpmPackage.version,
        });
        return undefined;
      }
    }

    await this.runAnalyzers(sfpmPackage);

    // Run pre-build hooks after analyzers have enriched the package context
    await this.runLifecycleHooks('pre', sfpmPackage);

    // Create builder via factory
    const modeConfig = resolveModeConfig(this.options.mode, this.options.skipValidation);
    const buildAs = (modeConfig.validation === 'local' && sfpmPackage.type === PackageType.Unlocked)
      ? PackageType.Source
      : undefined;

    const builderOptions: BuilderOptions = {
      artifact: modeConfig.artifact,
      installationKey: this.options.installationKey,
      validation: modeConfig.validation !== false,
      waitTime: this.options.waitTime,
      ...(modeConfig.dependencyAnalysis !== 'skip' && {
        dependencyAnalysis: {
          warnOnly: modeConfig.dependencyAnalysis === 'warn',
        },
      }),
    };

    const builderInstance = builderFactory(sfpmPackage, builderOptions, this.logger, this.sink, buildAs as PackageType);

    // Connect to org if needed
    const targetOrg = await this.resolveTargetOrg(sfpmPackage, modeConfig);
    if (targetOrg) {
      await builderInstance.connect(targetOrg);
    }

    this.sink?.builderStart({
      builderName: builderInstance.constructor.name,
      packageType: sfpmPackage.type as PackageType,
    });

    try {
      // Run pre-build tasks
      const preTasks = (builderInstance as any).tasks?.filter((t: BuildTaskRegistration) => t.phase === 'pre') ?? [];
      await this.runTasks(sfpmPackage, preTasks, 'pre-build');

      // Execute the builder
      const result = await builderInstance.exec();

      // Apply result to package
      this.applyBuilderResult(sfpmPackage, result);

      if (result.pendingValidation) {
        this.sink?.validateQueued({
          operationId: result.pendingValidation.operationId,
          operationType: result.pendingValidation.operationType,
        });
      }

      // Run post-build tasks
      const postTasks = (builderInstance as any).tasks?.filter((t: BuildTaskRegistration) => t.phase === 'post') ?? [];
      await this.runTasks(sfpmPackage, postTasks, 'post-build');

      this.sink?.builderComplete({
        builderName: builderInstance.constructor.name,
        componentCount,
        packageType: sfpmPackage.type as PackageType,
      });

      // Run post-build hooks
      await this.runLifecycleHooks('post', sfpmPackage);

      this.sink?.complete({
        packageVersionId: result.packageVersionId,
        success: true,
      });

      return result.pendingValidation;
    } catch (error: any) {
      this.sink?.error({
        error,
        phase: 'build',
      });
      throw error;
    }
  }

  /**
   * Run lifecycle hooks for the build operation.
   */
  private async runLifecycleHooks(
    timing: HookTiming,
    sfpmPackage: SfpmPackage,
  ): Promise<void> {
    if (!LifecycleEngine.isInitialized()) return;

    const lifecycle = LifecycleEngine.getInstance();
    const hookContext: HookContext = {
      logger: this.logger,
      operation: 'build',
      projectDir: this.provider.projectDir,
      sfpmPackage,
      stage: lifecycle.stage,
      targetOrg: this.options.devhubUsername,
      timing,
    };

    if (timing === 'pre') {
      await lifecycle.runBuildPre(hookContext, this.sink);
    } else {
      await lifecycle.runBuildPost(hookContext, this.sink);
    }
  }

  /**
   * Run task registrations sequentially, emitting lifecycle events.
   */
  private async runTasks(
    sfpmPackage: SfpmPackage,
    registrations: BuildTaskRegistration[],
    taskType: 'post-build' | 'pre-build',
  ): Promise<void> {
    const ctx: BuildTaskContext = {
      logger: this.logger,
      projectDirectory: this.provider.projectDir,
      sfpmPackage,
      sink: this.sink,
    };

    for (const registration of registrations) {
      const task = registration.factory(ctx);
      const taskName = task.name;

      // Check runtime precondition
      if (task.canRun && !task.canRun()) {
        this.sink?.taskSkip({
          reason: `Precondition not met for task '${taskName}'`,
          taskName,
          taskType,
        });
        continue;
      }

      this.sink?.taskStart({
        taskName,
        taskType,
      });

      try {
        // eslint-disable-next-line no-await-in-loop -- tasks run sequentially, stop on first failure
        const result = await task.exec();

        if (result?.enrichments) {
          this.applyEnrichments(sfpmPackage, result.enrichments);
        }
      } catch (error) {
        this.sink?.taskComplete({
          success: false,
          taskName,
          taskType,
        });

        throw error;
      }

      this.sink?.taskComplete({
        success: true,
        taskName,
        taskType,
      });
    }
  }

  private async stagePackage(sfpmPackage: SfpmPackage): Promise<number> {
    this.sink?.stageStart({
      stagingDirectory: sfpmPackage.workingDirectory,
    });

    try {
      const assemblyOutput = await new PackageAssembler(
        sfpmPackage.name,
        this.provider,
        {
          ignoreFilesConfig: this.ignoreFilesConfig,
          versionNumber: sfpmPackage.version,
        },
        this.logger,
      ).assemble();

      sfpmPackage.workingDirectory = assemblyOutput.stagingDirectory;

      this.sink?.stageComplete({
        componentCount: assemblyOutput.componentCount || 0,
        stagingDirectory: assemblyOutput.stagingDirectory,
      });

      return assemblyOutput.componentCount || 0;
    } catch (error: any) {
      this.sink?.error({
        error,
        phase: 'staging',
      });
      throw error;
    }
  }
}
