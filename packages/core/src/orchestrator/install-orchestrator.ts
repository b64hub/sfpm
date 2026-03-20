import {Org} from '@salesforce/core';
import EventEmitter from 'node:events';

import {ArtifactService} from '../artifacts/artifact-service.js';
import {LifecycleEngine} from '../lifecycle/lifecycle-engine.js';
import PackageInstaller, {InstallOptions} from '../package/package-installer.js';
import ProjectConfig from '../project/project-config.js';
import {ProjectGraph} from '../project/project-graph.js';
import {
  InstallEvents,
  OrchestrationEvents,
  OrchestrationResult,
  PackageResult,
} from '../types/events.js';
import {HookContext} from '../types/lifecycle.js';
import {Logger} from '../types/logger.js';
import {InstallationSource} from '../types/package.js';
import {
  OrchestrationTask,
  Orchestrator,
  OrchestratorEmitter,
  OrchestratorOptions,
} from './orchestrator.js';

export interface InstallOrchestratorOptions extends InstallOptions, OrchestratorOptions {}

/**
 * Shared context created once per orchestration run and threaded to each
 * single-package install so they share a connection and cache.
 */
interface InstallContext {
  artifactService: ArtifactService;
  org: Org;
}

// ============================================================================
// Task implementation
// ============================================================================

/**
 * {@link OrchestrationTask} for package installations.
 *
 * Creates a shared Org connection and pre-cached ArtifactService, then
 * delegates individual package installs to PackageInstaller.
 */
export class InstallOrchestrationTask implements OrchestrationTask<InstallContext> {
  private readonly lifecycle: LifecycleEngine | undefined;
  private readonly logger: Logger | undefined;
  private readonly options: InstallOptions;
  private readonly projectConfig: ProjectConfig;

  constructor(
    projectConfig: ProjectConfig,
    options: InstallOptions,
    logger?: Logger,
    lifecycle?: LifecycleEngine,
  ) {
    this.projectConfig = projectConfig;
    this.options = options;
    this.logger = logger;
    this.lifecycle = lifecycle;
  }

  async processSinglePackage(
    packageName: string,
    _level: number,
    context: InstallContext,
    emitter: OrchestratorEmitter,
  ): Promise<PackageResult> {
    const start = Date.now();

    // Check if this package should be skipped for the current lifecycle stage
    if (this.lifecycle) {
      const packageDefinition = this.projectConfig.getPackageDefinition(packageName);
      const skipStages = packageDefinition.packageOptions?.skip ?? [];
      if (skipStages.includes(this.lifecycle.stage)) {
        this.logger?.info(`Skipping '${packageName}' — stage '${this.lifecycle.stage}' is in skip list`);
        return {
          duration: 0, packageName, skipped: true, success: true,
        };
      }
    }

    const installer = new PackageInstaller(
      this.projectConfig,
      this.options,
      this.logger,
      context.org,
    );

    this.forwardInstallerEvents(installer, emitter);

    let success = true;
    let skipped = false;
    let error: string | undefined;

    try {
      // Run pre-install hooks
      if (this.lifecycle) {
        const hookContext = this.buildHookContext(packageName, context);
        await this.lifecycle.run('install', 'pre', hookContext);
      }

      const result = await installer.installPackage(packageName);
      if (result.skipped) {
        skipped = true;
      }

      // Run post-install hooks
      if (this.lifecycle && !result.skipped) {
        const hookContext = this.buildHookContext(packageName, context);
        await this.lifecycle.run('install', 'post', hookContext);
      }
    } catch (error_) {
      success = false;
      error = error_ instanceof Error ? error_.message : String(error_);
    }

    installer.removeAllListeners();

    const duration = Date.now() - start;
    return {
      duration, error, packageName, skipped, success,
    };
  }

  async setup(): Promise<InstallContext> {
    const org = await Org.create({aliasOrUsername: this.options.targetOrg});

    // Use singleton instance - cache is lazy-loaded automatically on first access
    const artifactService = ArtifactService.getInstance()
    .setOrg(org)
    .setLogger(this.logger);

    return {artifactService, org};
  }

  /**
   * Build a {@link HookContext} for lifecycle hooks at the install operation.
   * Provides the package definition, org, logger, and project directory.
   */
  private buildHookContext(packageName: string, context: InstallContext): HookContext {
    const packageDefinition = this.projectConfig.getPackageDefinition(packageName);

    return {
      logger: this.logger,
      operation: 'install',
      org: context.org,
      packageName,
      packageType: packageDefinition.type,
      sfpmPackage: {packageDefinition},
      stage: this.lifecycle?.stage ?? 'local',
      timing: '',
    };
  }

  private forwardInstallerEvents(installer: PackageInstaller, emitter: OrchestratorEmitter): void {
    const events = [
      'install:start',
      'install:skip',
      'install:complete',
      'install:error',
      'connection:start',
      'connection:complete',
      'deployment:start',
      'deployment:progress',
      'deployment:complete',
      'version-install:start',
      'version-install:progress',
      'version-install:complete',
    ] as const;

    for (const event of events) {
      installer.on(event, (...args: any[]) => {
        emitter.emit(event, ...args);
      });
    }
  }
}

// ============================================================================
// Orchestrator facade
// ============================================================================

/**
 * Orchestrates installing multiple packages in parallel, respecting dependency order.
 *
 * Composes the shared {@link Orchestrator} engine with an {@link InstallOrchestrationTask}
 * to handle install-specific setup and per-package processing.
 *
 * All installer and orchestration events are emitted through this instance,
 * so callers can subscribe with `orchestrator.on(event, handler)`.
 */
export class InstallOrchestrator extends EventEmitter<InstallEvents & OrchestrationEvents> {
  private readonly orchestrator: Orchestrator<InstallContext>;

  constructor(
    projectConfig: ProjectConfig,
    graph: ProjectGraph,
    options: InstallOrchestratorOptions,
    logger?: Logger,
    lifecycle?: LifecycleEngine,
  ) {
    super();
    const task = new InstallOrchestrationTask(projectConfig, options, logger, lifecycle);
    this.orchestrator = new Orchestrator(graph, {...options, includeManagedPackages: true}, task, logger, this);
  }

  // ========================================================================
  // Static factory methods
  // ========================================================================

  /**
   * Create an orchestrator for installing from built artifacts.
   * Uses artifact resolution (local or npm) to find the best version.
   */
  static forArtifact(
    projectConfig: ProjectConfig,
    graph: ProjectGraph,
    options: Omit<InstallOrchestratorOptions, 'source'> & {source?: never},
    logger?: Logger,
    lifecycle?: LifecycleEngine,
  ): InstallOrchestrator {
    return new InstallOrchestrator(
      projectConfig,
      graph,
      {...options, source: InstallationSource.Artifact},
      logger,
      lifecycle,
    );
  }

  /**
   * Create an orchestrator for installing directly from project source.
   * Deploys source metadata via the metadata API without artifact resolution.
   */
  static forSource(
    projectConfig: ProjectConfig,
    graph: ProjectGraph,
    options: Omit<InstallOrchestratorOptions, 'mode' | 'source'> & {mode?: never; source?: never},
    logger?: Logger,
    lifecycle?: LifecycleEngine,
  ): InstallOrchestrator {
    return new InstallOrchestrator(
      projectConfig,
      graph,
      {...options, source: InstallationSource.Local},
      logger,
      lifecycle,
    );
  }

  // ========================================================================
  // Public entry point
  // ========================================================================

  /**
   * Install multiple packages in dependency order.
   *
   * @param packageNames — Package names requested by the caller.
   *   When `includeDependencies` is true (default) all transitive dependencies
   *   are resolved and installed first.
   * @returns OrchestrationResult with per-package outcomes.
   */
  public async installAll(packageNames: string[]): Promise<OrchestrationResult> {
    return this.orchestrator.executeAll(packageNames);
  }
}
