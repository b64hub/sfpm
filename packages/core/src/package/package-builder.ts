import fs from 'fs-extra';
import {merge} from 'lodash-es';
import EventEmitter from 'node:events';
import path from 'node:path';

import type {ProjectDefinitionProvider} from '../project/providers/project-definition-provider.js';

import {GitService} from '../git/git-service.js';
import {IgnoreFilesConfig} from '../types/config.js';
import {NoSourceChangesError} from '../types/errors.js';
import {AllBuildEvents} from '../types/events.js';
import {Logger} from '../types/logger.js';
import {PackageType} from '../types/package.js';
import {AnalyzerRegistry} from './analyzers/analyzer-registry.js';
import PackageAssembler from './assemblers/package-assembler.js';
import {
  Builder, BuilderOptions, BuilderRegistry, BuildTask,
} from './builders/builder-registry.js';
import SfpmPackage, {PackageFactory} from './sfpm-package.js';

export interface BuildOptions {
  buildNumber?: string;
  destructiveManifestPath?: string;
  devhubUsername?: string;
  /** Force build even if no source changes detected */
  force?: boolean;
  /** Ignore files configuration for assembly */
  ignoreFilesConfig?: IgnoreFilesConfig;
  installationKey?: string;
  installationKeyBypass?: boolean;
  /** Use async validation for unlocked packages — returns immediately with a creation request ID */
  isAsyncValidation?: boolean;
  isSkipValidation?: boolean;
  orgDefinitionPath?: string;
  /** Timeout in minutes for package version creation (default: 120) */
  waitTime?: number;
}

/**
 * Orchestrator for package builds
 */
export class PackageBuilder extends EventEmitter<AllBuildEvents> {
  private gitService?: GitService;
  private logger: Logger | undefined;
  private options: BuildOptions;
  private provider: ProjectDefinitionProvider;

  constructor(provider: ProjectDefinitionProvider, options?: BuildOptions, logger?: Logger, gitService?: GitService) {
    super();
    this.options = options || {};
    this.logger = logger;
    this.provider = provider;
    this.gitService = gitService;
  }

  /**
   * @description Build multiple packages and their dependencies.
   * @deprecated Use BuildOrchestrator.buildAll() for multi-package builds.
   * This stub exists for backwards compatibility — the CLI drives the orchestrator directly.
   */
  public async build(): Promise<void> {}

  /**
   * @description Build a single package by name
   * @param packageName
   * @param projectDirectory
   * @returns
   */
  public async buildPackage(packageName: string, projectDirectory: string) {
    // Use PackageFactory to create a fully-configured package
    const packageFactory = new PackageFactory(this.provider);
    const sfpmPackage = packageFactory.createFromName(packageName);

    // Emit build start event
    this.emit('build:start', {
      buildNumber: this.options.buildNumber,
      packageName: sfpmPackage.packageName,
      packageType: sfpmPackage.type as PackageType,
      timestamp: new Date(),
      version: sfpmPackage.version,
    });

    // Merge build options from package definition
    if (sfpmPackage.packageDefinition?.packageOptions?.build) {
      merge(sfpmPackage.metadata.orchestration, {
        build: sfpmPackage.packageDefinition.packageOptions.build,
      });
    }

    if (this.options.buildNumber) {
      sfpmPackage.setBuildNumber(this.options.buildNumber);
    }

    if (this.options.orgDefinitionPath) {
      sfpmPackage.orgDefinitionPath = this.options.orgDefinitionPath;
    }

    // Set source context from git repository
    if (!this.gitService) {
      this.gitService = await GitService.initialize(projectDirectory, this.logger);
    }

    sfpmPackage.metadata.source = await this.gitService.getPackageSourceContext();

    // Apply orchestration options - each package type handles its own options
    sfpmPackage.setOrchestrationOptions({
      installationkey: this.options.installationKey,
      installationkeybypass: this.options.installationKeyBypass,
      isAsyncValidation: this.options.isAsyncValidation,
      isSkipValidation: this.options.isSkipValidation,
      waitTime: this.options.waitTime,
    });

    await this.stagePackage(sfpmPackage);

    try {
      // Skip empty packages before running analyzers or builder
      if (await this.isPackageEmpty(sfpmPackage)) {
        this.emit('build:skipped', {
          packageName: sfpmPackage.packageName,
          packageType: sfpmPackage.type as PackageType,
          reason: 'empty-package',
          timestamp: new Date(),
          version: sfpmPackage.version,
        });
        return;
      }

      await this.runAnalyzers(sfpmPackage);

      if (!sfpmPackage.workingDirectory) {
        const error = new Error('Package must be staged for build');
        this.emit('build:error', {
          error,
          packageName: sfpmPackage.packageName,
          phase: 'staging',
          timestamp: new Date(),
        });
        throw error;
      }

      const BuilderClass = BuilderRegistry.getBuilder(sfpmPackage.type);

      if (!BuilderClass) {
        const error = new Error(`No builder registered for package type: ${sfpmPackage.type}`);
        this.emit('build:error', {
          error,
          packageName: sfpmPackage.packageName,
          phase: 'build',
          timestamp: new Date(),
        });
        throw error;
      }

      // Build options for the builder from sfpm.config.ts
      const builderOptions: BuilderOptions = {
        ignoreFilesConfig: this.options.ignoreFilesConfig,
      };

      const builderInstance: Builder = new BuilderClass(
        sfpmPackage.workingDirectory,
        sfpmPackage,
        builderOptions,
        this.logger,
      );

      // Skip source hash check when force is enabled
      if (this.options.force && builderInstance.preBuildTasks) {
        builderInstance.preBuildTasks = builderInstance.preBuildTasks.filter(task => task.constructor.name !== 'SourceHashTask');
        this.logger?.info('Force build enabled - skipping source change detection');
      }

      // Connect to dev hub if needed
      if (this.options.devhubUsername) {
        await this.connectToDevHub(sfpmPackage, builderInstance, this.options.devhubUsername);
      }

      // Execute the builder
      await this.executeBuilder(sfpmPackage, builderInstance, BuilderClass.name);

      // Emit build complete
      this.emit('build:complete', {
        packageName: sfpmPackage.packageName,
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
      packageName: sfpmPackage.packageName,
      timestamp: new Date(),
    });

    try {
      // Run all analyzers in parallel
      const analyzerPromises = enabledAnalyzers.map(async analyzer => {
        const analyzerName = analyzer.constructor.name;

        this.emit('analyzer:start', {
          analyzerName,
          packageName: sfpmPackage.packageName,
          timestamp: new Date(),
        });

        try {
          const metadataContribution = await analyzer.analyze(sfpmPackage);
          merge(sfpmPackage.metadata, metadataContribution);

          this.emit('analyzer:complete', {
            analyzerName,
            findings: metadataContribution,
            packageName: sfpmPackage.packageName,
            timestamp: new Date(),
          });

          return {analyzerName, success: true};
        } catch (error) {
          this.emit('analyzer:complete', {
            analyzerName,
            error: error instanceof Error ? error.message : String(error),
            findings: {},
            packageName: sfpmPackage.packageName,
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
        packageName: sfpmPackage.packageName,
        timestamp: new Date(),
      });
    } catch (error: any) {
      this.emit('build:error', {
        error,
        packageName: sfpmPackage.packageName,
        phase: 'analysis',
        timestamp: new Date(),
      });
      throw error;
    }
  }

  public async stagePackage(sfpmPackage: SfpmPackage): Promise<void> {
    this.emit('stage:start', {
      packageName: sfpmPackage.packageName,
      stagingDirectory: sfpmPackage.workingDirectory,
      timestamp: new Date(),
    });

    try {
      const assemblyOutput = await new PackageAssembler(
        sfpmPackage.packageName,
        this.provider,
        {
          destructiveManifestPath: this.options.destructiveManifestPath,
          ignoreFilesConfig: this.options.ignoreFilesConfig,
          orgDefinitionPath: this.options.orgDefinitionPath,
          versionNumber: sfpmPackage.version,
        },
        this.logger,
      ).assemble();

      sfpmPackage.workingDirectory = assemblyOutput.stagingDirectory;

      this.emit('stage:complete', {
        componentCount: assemblyOutput.componentCount || 0,
        packageName: sfpmPackage.packageName,
        stagingDirectory: assemblyOutput.stagingDirectory,
        timestamp: new Date(),
      });
    } catch (error: any) {
      this.emit('build:error', {
        error,
        packageName: sfpmPackage.packageName,
        phase: 'staging',
        timestamp: new Date(),
      });
      throw error;
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
      'source:test:start',
      'source:test:complete',
      'task:start',
      'task:complete',
    ];

    for (const eventName of eventsToBubble) {
      builderInstance.on(eventName, (...args: any[]) => {
        this.emit(eventName as any, ...args);
      });
    }
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
      packageName: sfpmPackage.packageName,
      timestamp: new Date(),
      username: devhubUsername,
    });

    try {
      await builderInstance.connect(devhubUsername);

      this.emit('connection:complete', {
        packageName: sfpmPackage.packageName,
        timestamp: new Date(),
        username: devhubUsername,
      });
    } catch (error: any) {
      this.emit('build:error', {
        error,
        packageName: sfpmPackage.packageName,
        phase: 'connection',
        timestamp: new Date(),
      });
      throw error;
    }
  }

  private async executeBuilder(sfpmPackage: SfpmPackage, builderInstance: Builder, builderName: string): Promise<any> {
    this.emit('builder:start', {
      builderName,
      packageName: sfpmPackage.packageName,
      packageType: sfpmPackage.type as PackageType,
      timestamp: new Date(),
    });

    // Bubble up events from builder if it's an EventEmitter
    if (builderInstance instanceof EventEmitter) {
      this.bubbleEvents(builderInstance);
    }

    try {
      await this.runTasks(sfpmPackage, builderInstance.preBuildTasks ?? [], 'pre-build');
      const result = await builderInstance.exec();
      await this.runTasks(sfpmPackage, builderInstance.postBuildTasks ?? [], 'post-build');

      this.emit('builder:complete', {
        builderName,
        packageName: sfpmPackage.packageName,
        packageType: sfpmPackage.type as PackageType,
        timestamp: new Date(),
      });

      return result;
    } catch (error: any) {
      // Handle no source changes as a successful skip
      if (error instanceof NoSourceChangesError) {
        this.emit('build:skipped', {
          artifactPath: error.artifactPath,
          latestVersion: error.latestVersion,
          packageName: sfpmPackage.packageName,
          packageType: sfpmPackage.type as PackageType,
          reason: 'no-changes',
          sourceHash: error.sourceHash,
          timestamp: new Date(),
          version: sfpmPackage.version,
        });
        return; // Exit gracefully without error
      }

      // Handle actual build errors
      this.emit('build:error', {
        error,
        packageName: sfpmPackage.packageName,
        phase: 'build',
        timestamp: new Date(),
      });
      throw error;
    }
  }

  /** Check whether a staged package contains zero deployable components or files. */
  private async isPackageEmpty(sfpmPackage: SfpmPackage): Promise<boolean> {
    return (await sfpmPackage.componentCount()) === 0;
  }

  /** Run a list of build tasks sequentially, emitting task:start/task:complete events. */
  private async runTasks(
    sfpmPackage: SfpmPackage,
    tasks: BuildTask[],
    taskType: 'post-build' | 'pre-build',
  ): Promise<void> {
    for (const task of tasks) {
      const taskName = task.constructor.name;

      this.emit('task:start', {
        packageName: sfpmPackage.packageName,
        taskName,
        taskType,
        timestamp: new Date(),
      });

      try {
        // eslint-disable-next-line no-await-in-loop -- tasks run sequentially, stop on first failure
        await task.exec();

        this.emit('task:complete', {
          packageName: sfpmPackage.packageName,
          success: true,
          taskName,
          taskType,
          timestamp: new Date(),
        });
      } catch (error) {
        const success = error instanceof Error && (error as any).code === 'BUILD_NOT_REQUIRED';

        this.emit('task:complete', {
          packageName: sfpmPackage.packageName,
          success,
          taskName,
          taskType,
          timestamp: new Date(),
        });

        throw error;
      }
    }
  }
}
