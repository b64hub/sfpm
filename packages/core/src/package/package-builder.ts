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
  Builder, builderFactory, BuilderOptions, BuilderResult,
  BuildTaskContext, BuildTaskRegistration, BuildTaskResult,
} from './builders/builder-registry.js';
import SfpmPackage, {PackageFactory, SfpmMetadataPackage} from './sfpm-package.js';

/**
 * Validation level for builds.
 *
 * - `none`  — assemble only, no analysis, no org interaction
 * - `local` — static analysis only (dependency checks), no org
 * - `org`   — org validation only (deploy+test for source, SF API for unlocked)
 * - `full`  — static analysis + org validation (default)
 */
export type ValidationLevel = 'full' | 'local' | 'none' | 'org';

/**
 * Internal configuration resolved from {@link ValidationLevel}.
 */
interface ModeConfig {
  /** Whether to run static analysis (dependency checks, etc.) */
  analysis: boolean;
  /** Whether to connect to and validate against an org */
  orgValidation: boolean;
}

const VALIDATION_CONFIGS: Record<ValidationLevel, ModeConfig> = {
  full: {
    analysis: true,
    orgValidation: true,
  },
  local: {
    analysis: true,
    orgValidation: false,
  },
  none: {
    analysis: false,
    orgValidation: false,
  },
  org: {
    analysis: false,
    orgValidation: true,
  },
};

function resolveModeConfig(validation?: ValidationLevel): ModeConfig {
  return VALIDATION_CONFIGS[validation ?? 'full'];
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
  /** Target org for source package validation (deploy + test) */
  buildOrg?: string;
  /** DevHub username or alias for unlocked package builds */
  devhubUsername?: string;
  /** Force build even if no source changes detected (skip hash check) */
  force?: boolean;
  /** Installation key for unlocked packages */
  installationKey?: string;
  /**
   * Unlocked packages are deployed as source instead of creating a package version.
   * No DevHub required. Designed for PR validation against scratch orgs.
   */
  sourceOnly?: boolean;
  /**
   * Validation level. Controls which quality gates run during the build.
   *
   * - `full`  — static analysis + org validation (default)
   * - `org`   — org validation only (skip static analysis)
   * - `local` — static analysis only (no org connection)
   * - `none`  — assemble only
   */
  validation?: ValidationLevel;
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
    this.options.validation = 'local';
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
   * Compare the current source hash against the latest artifact manifest.
   * Returns match info if hashes are equal, undefined otherwise.
   */
  private async checkSourceHash(
    sfpmPackage: SfpmMetadataPackage,
    repo: ArtifactRepository,
  ): Promise<undefined | {artifactPath?: string; latestVersion?: string}> {
    const currentSourceHash = await SourceHasher.calculate(sfpmPackage);
    this.logger?.debug(`Source hash: ${currentSourceHash}`);

    const match = await repo.checkSourceHash(currentSourceHash);
    if (!match) {
      this.logger?.info('Source changes detected, proceeding with build');
    }

    return match;
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
   * Check whether the existing manifest satisfies the current build's requirements.
   *
   * An unlocked package with org/full validation (not source-only) requires a
   * packageVersionId in the manifest. A previous --source-only or --validation=local
   * build won't have one, so a rebuild is needed despite matching source hash.
   */
  private async manifestSatisfiesBuild(
    sfpmPackage: SfpmPackage,
    repo: ArtifactRepository,
  ): Promise<boolean> {
    const needsPackageVersionId = sfpmPackage.type === PackageType.Unlocked
      && !this.options.sourceOnly
      && (this.options.validation === 'org' || this.options.validation === 'full' || !this.options.validation);

    if (!needsPackageVersionId) return true;

    const manifest = await repo.getManifest();
    if (!manifest?.packageVersionId) {
      this.logger?.info(`Build required for '${sfpmPackage.packageName}': existing build has no packageVersionId`);
      return false;
    }

    return true;
  }

  /**
   * Determine whether a build is needed for this package.
   *
   * Checks two conditions:
   * 1. Source hash — has the source changed since the last build?
   * 2. Manifest completeness — does the existing build output satisfy
   *    the current build's requirements (e.g., packageVersionId for
   *    unlocked packages with org validation)?
   *
   * Returns skip info when the build can be skipped, or undefined to proceed.
   */
  private async needsBuild(sfpmPackage: SfpmPackage): Promise<undefined | {artifactPath?: string; latestVersion?: string}> {
    if (!(sfpmPackage instanceof SfpmMetadataPackage)) {
      return undefined;
    }

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

    // 1. Check source hash
    const hashMatch = await this.checkSourceHash(sfpmPackage, repo);
    if (!hashMatch) return undefined;

    // 2. Check manifest completeness
    if (!await this.manifestSatisfiesBuild(sfpmPackage, repo)) return undefined;

    this.logger?.info(`Build skipped for '${sfpmPackage.packageName}': no source changes detected. `
      + `Latest version: ${hashMatch.latestVersion}`);
    return hashMatch;
  }

  /**
   * Resolve the target org for the builder based on package type.
   * Returns undefined when org validation is disabled.
   */
  private async resolveTargetOrg(sfpmPackage: SfpmPackage, modeConfig: ModeConfig): Promise<Org | undefined> {
    if (!modeConfig.orgValidation) return undefined;

    let username: string | undefined;
    // With --source-only, unlocked packages use the build org (not DevHub)
    if (sfpmPackage.type === PackageType.Unlocked && !this.options.sourceOnly) {
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
      const skip = await this.needsBuild(sfpmPackage);
      if (skip) {
        this.sink?.skip({
          artifactPath: skip.artifactPath,
          latestVersion: skip.latestVersion,
          packageType: sfpmPackage.type as PackageType,
          reason: 'no-changes',
          version: sfpmPackage.version,
        });
        return undefined;
      }
    }

    const modeConfig = resolveModeConfig(this.options.validation);

    if (modeConfig.analysis) {
      await this.runAnalyzers(sfpmPackage);
    }

    // Run pre-build hooks after analyzers have enriched the package context
    await this.runLifecycleHooks('pre', sfpmPackage);

    // Route unlocked packages through source builder when:
    // - no org validation (local/none), or
    // - --source-only mode (PR validation without DevHub)
    const buildAs = ((!modeConfig.orgValidation || this.options.sourceOnly) && sfpmPackage.type === PackageType.Unlocked)
      ? PackageType.Source
      : undefined;

    const builderOptions: BuilderOptions = {
      installationKey: this.options.installationKey,
      validation: modeConfig.orgValidation,
      waitTime: this.options.waitTime,
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
      await this.runTasks(sfpmPackage, builderInstance, 'pre');

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
      await this.runTasks(sfpmPackage, builderInstance, 'post');

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
    builderInstance: Builder,
    phase: 'post' | 'pre',
  ): Promise<void> {
    const registrations = builderInstance.tasks.filter(t => t.phase === phase);
    const taskType = `${phase}-build` as 'post-build' | 'pre-build';

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
