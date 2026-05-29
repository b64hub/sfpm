import fs from 'fs-extra';
import {merge} from 'lodash-es';
import EventEmitter from 'node:events';
import path from 'node:path';

import type {ProjectDefinitionProvider} from '../project/providers/project-definition-provider.js';

import {GitService} from '../git/git-service.js';
import {LifecycleEngine} from '../lifecycle/lifecycle-engine.js';
import {ArtifactManifest} from '../types/artifact.js';
import {IgnoreFilesConfig} from '../types/config.js';
import {AllBuildEvents} from '../types/events.js';
import {HookContext, HookTiming} from '../types/lifecycle.js';
import {Logger} from '../types/logger.js';
import {PackageType} from '../types/package.js';
import {getPipelineRunId} from '../utils/pipeline.js';
import {AnalyzerRegistry} from './analyzers/analyzer-registry.js';
import PackageAssembler from './assemblers/package-assembler.js';
import {
  Builder, BuilderOptions, BuilderRegistry,
  BuildTaskContext, BuildTaskRegistration, BuildTaskResult,
} from './builders/builder-registry.js';
import SfpmPackage, {PackageFactory, SfpmMetadataPackage} from './sfpm-package.js';

export type BuildMode = 'build' | 'build:dry-run' | 'build:skip-validation';

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
  /** Whether to create git tags */
  gitTag: boolean;
  /** Whether to run validation */
  validation: 'local' | boolean;
}

const MODE_DEFAULTS: Record<BuildMode, ModeConfig> = {
  build: {
    artifact: true,
    dependencyAnalysis: 'warn',
    gitTag: true,
    validation: true,
  },
  'build:dry-run': {
    artifact: false,
    dependencyAnalysis: 'error',
    gitTag: false,
    validation: 'local',
  },
  'build:skip-validation': {
    artifact: true,
    dependencyAnalysis: 'skip',
    gitTag: true,
    validation: false,
  },
};

function resolveModeConfig(mode?: BuildMode): ModeConfig {
  return MODE_DEFAULTS[mode ?? 'build'];
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
   * - `build` (default) — production-ready artifact with full validation.
   *   Source packages: deploy+test against buildOrg. Unlocked: SF API with async validation + code coverage.
   * - `build:skip-validation` — fast build, no validation. Source: no deploy+test.
   *   Unlocked: SF API with skipvalidation=true.
   * - `dry-run` — maximum validation, no real SF API build, no git tags, no artifacts.
   *   All packages go through the source pipeline with deploy+test.
   */
  mode?: BuildMode;
  /** Timeout in minutes for package version creation (default: 120) */
  waitTime?: number;
}

/**
 * Orchestrator for package builds
 */
export class PackageBuilder extends EventEmitter<AllBuildEvents> {
  private gitService?: GitService;
  private ignoreFilesConfig?: IgnoreFilesConfig;
  private logger: Logger | undefined;
  private options: BuildOptions;
  private provider: ProjectDefinitionProvider;

  constructor(
    provider: ProjectDefinitionProvider,
    options?: BuildOptions,
    logger?: Logger,
    gitService?: GitService,
    ignoreFilesConfig?: IgnoreFilesConfig,
  ) {
    super();
    this.options = options || {};
    this.logger = logger;
    this.provider = provider;
    this.gitService = gitService;
    this.ignoreFilesConfig = ignoreFilesConfig;
  }

  /**
   * @description Build a single package by name
   * @param packageName
   * @param projectDirectory
   * @returns
   */
  public async buildPackage(packageName: string, projectDirectory: string) {
    const packageFactory = new PackageFactory(this.provider);
    const sfpmPackage = packageFactory.createFromName(packageName);

    this.emit('build:start', {
      buildNumber: this.options.buildNumber,
      packageName: sfpmPackage.name,
      packageType: sfpmPackage.type as PackageType,
      timestamp: new Date(),
      version: sfpmPackage.version,
    });

    this.handleBuildConfiguration(sfpmPackage);
    await this.handleSourceContext(sfpmPackage, projectDirectory);
    await this.stagePackage(sfpmPackage);

    try {
      if (await this.isPackageEmpty(sfpmPackage)) {
        this.emit('build:skipped', {
          packageName: sfpmPackage.name,
          packageType: sfpmPackage.type as PackageType,
          reason: 'empty-package',
          timestamp: new Date(),
          version: sfpmPackage.version,
        });
        return;
      }

      const hashSkip = await this.checkSourceHash(sfpmPackage, projectDirectory);
      if (hashSkip) {
        this.emit('build:skipped', {
          artifactPath: hashSkip.artifactPath,
          latestVersion: hashSkip.latestVersion,
          packageName: sfpmPackage.name,
          packageType: sfpmPackage.type as PackageType,
          reason: 'no-changes',
          timestamp: new Date(),
          version: sfpmPackage.version,
        });
        return;
      }

      await this.runAnalyzers(sfpmPackage);

      // Run pre-build hooks after analyzers have enriched the package context
      await this.runLifecycleHooks('pre', sfpmPackage, projectDirectory);

      const builderInstance = await this.handleBuilderSetup(sfpmPackage);
      await this.executeBuilder(sfpmPackage, builderInstance, builderInstance.constructor.name);

      // Run post-build hooks
      await this.runLifecycleHooks('post', sfpmPackage, projectDirectory);

      this.emit('build:complete', {
        packageName: sfpmPackage.name,
        packageVersionId: 'packageVersionId' in sfpmPackage ? (sfpmPackage.packageVersionId as string) : undefined,
        success: true,
        timestamp: new Date(),
      });
    } finally {
      await this.cleanupStagingDirectory(sfpmPackage);
    }
  }

  public async runAnalyzers(sfpmPackage: SfpmPackage): Promise<void> {
    if (sfpmPackage.type === PackageType.Data) {
      return;
    }

    const analyzers = AnalyzerRegistry.getAnalyzers(this.logger);
    const enabledAnalyzers = analyzers.filter(a => a.isEnabled(sfpmPackage));

    this.emit('analyzers:start', {
      analyzerCount: enabledAnalyzers.length,
      packageName: sfpmPackage.name,
      timestamp: new Date(),
    });

    try {
      // Run all analyzers in parallel
      const analyzerPromises = enabledAnalyzers.map(async analyzer => {
        const analyzerName = analyzer.constructor.name;

        this.emit('analyzer:start', {
          analyzerName,
          packageName: sfpmPackage.name,
          timestamp: new Date(),
        });

        try {
          const metadataContribution = await analyzer.analyze(sfpmPackage);
          merge(sfpmPackage.metadata, metadataContribution);

          this.emit('analyzer:complete', {
            analyzerName,
            findings: metadataContribution,
            packageName: sfpmPackage.name,
            timestamp: new Date(),
          });

          return {analyzerName, success: true};
        } catch (error) {
          this.emit('analyzer:complete', {
            analyzerName,
            error: error instanceof Error ? error.message : String(error),
            findings: {},
            packageName: sfpmPackage.name,
            timestamp: new Date(),
          });

          // Re-throw with analyzer context for better error messages
          const message = error instanceof Error ? error.message : String(error);
          throw new Error(`[${analyzerName}] ${message}`, {cause: error});
        }
      });

      await Promise.all(analyzerPromises);

      this.emit('analyzers:complete', {
        completedCount: enabledAnalyzers.length,
        packageName: sfpmPackage.name,
        timestamp: new Date(),
      });
    } catch (error: any) {
      this.emit('build:error', {
        error,
        packageName: sfpmPackage.name,
        phase: 'analysis',
        timestamp: new Date(),
      });
      throw error;
    }
  }

  public async stagePackage(sfpmPackage: SfpmPackage): Promise<void> {
    this.emit('stage:start', {
      packageName: sfpmPackage.name,
      stagingDirectory: sfpmPackage.workingDirectory,
      timestamp: new Date(),
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

      this.emit('stage:complete', {
        componentCount: assemblyOutput.componentCount || 0,
        packageName: sfpmPackage.name,
        stagingDirectory: assemblyOutput.stagingDirectory,
        timestamp: new Date(),
      });
    } catch (error: any) {
      this.emit('build:error', {
        error,
        packageName: sfpmPackage.name,
        phase: 'staging',
        timestamp: new Date(),
      });
      throw error;
    }
  }

  /** Apply task enrichments to the package. */
  private applyEnrichments(sfpmPackage: SfpmPackage, enrichments: NonNullable<BuildTaskResult['enrichments']>): void {
    if (enrichments.testCoverage !== undefined && 'testCoverage' in sfpmPackage) {
      (sfpmPackage as SfpmMetadataPackage).testCoverage = enrichments.testCoverage;
    }

    if (enrichments.sourceTag !== undefined) {
      sfpmPackage.metadata.source.tag = enrichments.sourceTag;
    }
  }

  /**
   * Bubble up events from builder instances to PackageBuilder
   */
  private bubbleEvents(builderInstance: EventEmitter): void {
    // Define which events to bubble up
    const eventsToBubble = [
      'unlocked:prune:start',
      'unlocked:prune:complete',
      'unlocked:create:start',
      'unlocked:create:progress',
      'unlocked:create:complete',
      'unlocked:validation:start',
      'unlocked:validation:complete',
      'source:assemble:start',
      'source:assemble:complete',
      'task:start',
      'task:complete',
      'task:skipped',
      'task:validation:start',
      'task:validation:progress',
      'task:validation:complete',
    ];

    for (const eventName of eventsToBubble) {
      builderInstance.on(eventName, (...args: any[]) => {
        this.emit(eventName as any, ...args);
      });
    }
  }

  /**
   * Source hash guard — determines whether a build is necessary by comparing
   * the current source hash against the latest artifact manifest entry.
   *
   * Always calculates and sets the hash on the package (needed for artifact metadata).
   * Returns skip info when the hash matches a previous build and `force` is not set.
   */
  private async checkSourceHash(
    sfpmPackage: SfpmPackage,
    projectDirectory: string,
  ): Promise<undefined | {artifactPath?: string; latestVersion?: string}> {
    if (!(sfpmPackage instanceof SfpmMetadataPackage)) {
      return undefined;
    }

    const currentSourceHash = await sfpmPackage.calculateSourceHash();
    this.logger?.debug(`Source hash: ${currentSourceHash}`);

    if (this.options.force) {
      this.logger?.info('Force build enabled — skipping source change detection');
      return undefined;
    }

    const manifestPath = path.join(projectDirectory, 'artifacts', sfpmPackage.packageName, 'manifest.json');

    if (!(await fs.pathExists(manifestPath))) {
      this.logger?.info('No previous builds found, proceeding with build');
      return undefined;
    }

    const manifest: ArtifactManifest = await fs.readJson(manifestPath);
    const latestVersion = manifest.versions[manifest.latest];

    if (!latestVersion?.sourceHash) {
      this.logger?.info('No previous source hash found, proceeding with build');
      return undefined;
    }

    if (latestVersion.sourceHash === currentSourceHash) {
      this.logger?.info(`Build skipped for '${sfpmPackage.packageName}': no source changes detected. `
        + `Latest version: ${manifest.latest}, hash: ${currentSourceHash}`);
      return {artifactPath: latestVersion.path, latestVersion: manifest.latest};
    }

    this.logger?.info('Source changes detected, proceeding with build');
    this.logger?.debug(`Previous hash: ${latestVersion.sourceHash}, current: ${currentSourceHash}`);
    return undefined;
  }

  /**
   * Remove the build directory that contains the staging area.
   *
   * The staging directory is `.sfpm/tmp/builds/<buildName>/package/`; the
   * parent (`<buildName>/`) is the workspace directory that must be cleaned.
   * If ArtifactAssembler already removed it on a successful build this is a
   * safe no-op.  Cleanup is skipped when `DEBUG=true` to allow inspection.
   */
  private async cleanupStagingDirectory(sfpmPackage: SfpmPackage): Promise<void> {
    if (process.env.DEBUG === 'true') return;
    if (!sfpmPackage.workingDirectory) return;

    const buildDir = path.dirname(sfpmPackage.workingDirectory);
    await fs.remove(buildDir).catch(() => {/* already removed or inaccessible */});
  }

  private async connectToDevHub(
    sfpmPackage: SfpmPackage,
    builderInstance: Builder,
    devhubUsername: string,
  ): Promise<void> {
    this.emit('connection:start', {
      orgType: 'devhub',
      packageName: sfpmPackage.name,
      timestamp: new Date(),
      username: devhubUsername,
    });

    try {
      await builderInstance.connect(devhubUsername);

      this.emit('connection:complete', {
        packageName: sfpmPackage.name,
        timestamp: new Date(),
        username: devhubUsername,
      });
    } catch (error: any) {
      this.emit('build:error', {
        error,
        packageName: sfpmPackage.name,
        phase: 'connection',
        timestamp: new Date(),
      });
      throw error;
    }
  }

  private async executeBuilder(sfpmPackage: SfpmPackage, builderInstance: Builder, builderName: string): Promise<void> {
    this.emit('builder:start', {
      builderName,
      packageName: sfpmPackage.name,
      packageType: sfpmPackage.type as PackageType,
      timestamp: new Date(),
    });

    // Bubble up events from builder if it's an EventEmitter
    if (builderInstance instanceof EventEmitter) {
      this.bubbleEvents(builderInstance);
    }

    // Build task context — shared by all tasks for this package
    const ctx: BuildTaskContext = {
      eventEmitter: this,
      logger: this.logger,
      projectDirectory: sfpmPackage.projectDirectory,
      sfpmPackage,
    };

    const preTasks = builderInstance.tasks.filter(t => t.phase === 'pre');
    const postTasks = builderInstance.tasks.filter(t => t.phase === 'post');

    try {
      await this.runTasks(sfpmPackage, preTasks, ctx, 'pre-build');

      await builderInstance.exec();

      await this.runTasks(sfpmPackage, postTasks, ctx, 'post-build');

      this.emit('builder:complete', {
        builderName,
        packageName: sfpmPackage.name,
        packageType: sfpmPackage.type as PackageType,
        timestamp: new Date(),
      });
    } catch (error: any) {
      // Handle actual build errors
      this.emit('build:error', {
        error,
        packageName: sfpmPackage.name,
        phase: 'build',
        timestamp: new Date(),
      });
      throw error;
    }
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
      // Source and data packages don't get build numbers from Salesforce.
      // Generate one from the CI pipeline run ID or a timestamp to ensure
      // each build produces a unique, ever-increasing version.
      const autoBuildNumber = getPipelineRunId() ?? String(Math.floor(Date.now() / 1000));
      sfpmPackage.setBuildNumber(autoBuildNumber);
      this.logger?.debug(`Auto-assigned build number ${autoBuildNumber} for ${sfpmPackage.name}`);
    }
  }

  /**
   * Resolve and instantiate the appropriate builder for the package type.
   * Uses {@link ModeConfig} to determine builder routing, validation, and feature flags.
   */
  private async handleBuilderSetup(sfpmPackage: SfpmPackage): Promise<Builder> {
    if (!sfpmPackage.workingDirectory) {
      const error = new Error('Package must be staged for build');
      this.emit('build:error', {
        error,
        packageName: sfpmPackage.name,
        phase: 'staging',
        timestamp: new Date(),
      });
      throw error;
    }

    const modeConfig = resolveModeConfig(this.options.mode);

    // In dry-run mode (local validation), force all packages through SourcePackageBuilder
    const useSourceBuilder = modeConfig.validation === 'local';
    const builderType = (useSourceBuilder && sfpmPackage.type === PackageType.Unlocked)
      ? PackageType.Source
      : sfpmPackage.type;

    const BuilderClass = BuilderRegistry.getBuilder(builderType);

    if (!BuilderClass) {
      const error = new Error(`No builder registered for package type: ${sfpmPackage.type}`);
      this.emit('build:error', {
        error,
        packageName: sfpmPackage.name,
        phase: 'build',
        timestamp: new Date(),
      });
      throw error;
    }

    const builderOptions: BuilderOptions = {
      artifact: modeConfig.artifact,
      buildOrg: this.options.buildOrg,
      gitTag: modeConfig.gitTag,
      installationKey: this.options.installationKey,
      validation: modeConfig.validation !== false,
      waitTime: this.options.waitTime,
      ...(modeConfig.dependencyAnalysis !== 'skip' && {
        dependencyAnalysis: {
          warnOnly: modeConfig.dependencyAnalysis === 'warn',
        },
      }),
    };

    const builderInstance: Builder = new BuilderClass(
      sfpmPackage.workingDirectory,
      sfpmPackage,
      builderOptions,
      this.logger,
    );

    // Connect to the appropriate org based on mode
    if (this.options.buildOrg && (useSourceBuilder || modeConfig.validation !== false)) {
      await builderInstance.connect(this.options.buildOrg);
    } else if (this.options.devhubUsername) {
      await this.connectToDevHub(sfpmPackage, builderInstance, this.options.devhubUsername);
    }

    return builderInstance;
  }

  /**
   * Initialize the git service and attach source context (commit, branch, repo) to the package.
   */
  private async handleSourceContext(sfpmPackage: SfpmPackage, projectDirectory: string): Promise<void> {
    if (!this.gitService) {
      this.gitService = await GitService.initialize(projectDirectory, this.logger);
    }

    sfpmPackage.metadata.source = await this.gitService.getPackageSourceContext();
  }

  /** Check whether a staged package contains zero deployable components or files. */
  private async isPackageEmpty(sfpmPackage: SfpmPackage): Promise<boolean> {
    return (await sfpmPackage.componentCount()) === 0;
  }

  /**
   * Run lifecycle hooks for the build operation if the engine is initialized.
   *
   * The hooks receive the enriched {@link SfpmPackage} instance — the same one
   * used for staging, analysis, and building — so hook handlers have access to
   * the full package context (component set, metadata, working directory, etc.).
   */
  private async runLifecycleHooks(
    timing: HookTiming,
    sfpmPackage: SfpmPackage,
    projectDirectory: string,
  ): Promise<void> {
    if (!LifecycleEngine.isInitialized()) return;

    const lifecycle = LifecycleEngine.getInstance();
    const hookContext: HookContext = {
      logger: this.logger,
      operation: 'build',
      projectDir: projectDirectory,
      sfpmPackage,
      stage: lifecycle.stage,
      targetOrg: this.options.devhubUsername,
      timing,
    };

    const hookEvents = ['hooks:start', 'hook:complete', 'hooks:complete'] as const;
    const forwarders = hookEvents.map(evt => {
      const fn = (...args: any[]) => this.emit(evt as any, ...args);
      lifecycle.on(evt, fn);
      return {evt, fn};
    });

    try {
      if (timing === 'pre') {
        await lifecycle.runBuildPre(hookContext);
      } else {
        await lifecycle.runBuildPost(hookContext);
      }
    } finally {
      for (const {evt, fn} of forwarders) lifecycle.removeListener(evt, fn);
    }
  }

  /**
   * Run task registrations sequentially, emitting lifecycle events.
   */
  private async runTasks(
    sfpmPackage: SfpmPackage,
    registrations: BuildTaskRegistration[],
    ctx: BuildTaskContext,
    taskType: 'post-build' | 'pre-build',
  ): Promise<void> {
    for (const registration of registrations) {
      const task = registration.factory(ctx);
      const taskName = task.name;

      // Check runtime precondition
      if (task.canRun && !task.canRun()) {
        this.emit('task:skipped', {
          packageName: sfpmPackage.name,
          reason: `Precondition not met for task '${taskName}'`,
          taskName,
          taskType,
          timestamp: new Date(),
        });
        continue;
      }

      this.emit('task:start', {
        packageName: sfpmPackage.name,
        taskName,
        taskType,
        timestamp: new Date(),
      });

      try {
        // eslint-disable-next-line no-await-in-loop -- tasks run sequentially, stop on first failure
        const result = await task.exec();

        if (result?.enrichments) {
          this.applyEnrichments(sfpmPackage, result.enrichments);
        }

        this.emit('task:complete', {
          packageName: sfpmPackage.name,
          success: true,
          taskName,
          taskType,
          timestamp: new Date(),
        });
      } catch (error) {
        this.emit('task:complete', {
          packageName: sfpmPackage.name,
          success: false,
          taskName,
          taskType,
          timestamp: new Date(),
        });

        throw error;
      }
    }
  }
}
