import {randomUUID} from 'node:crypto';

import type {
  OrchestrationResult,
  PackageResult,
} from '../events/orchestration-event-bus.js';
import type {ProjectDefinitionProvider} from '../project/providers/project-definition-provider.js';
import type {PendingValidationDescriptor} from '../types/package.js';

import {BuildEventBus} from '../events/build-event-bus.js';
import {OrchestrationEventBus} from '../events/orchestration-event-bus.js';
import {GitService} from '../git/git-service.js';
import {LifecycleEngine} from '../lifecycle/lifecycle-engine.js';
import {BuildOptions, PackageBuilder} from '../package/package-builder.js';
import {ProjectGraph} from '../project/project-graph.js';
import {IgnoreFilesConfig} from '../types/config.js';
import {Logger} from '../types/logger.js';
import {
  OrchestrationTask,
  Orchestrator,
  OrchestratorOptions,
} from './orchestrator.js';

export interface BuildOrchestratorOptions extends BuildOptions, OrchestratorOptions {
  /** Ignore files configuration resolved from sfpm config. */
  ignoreFilesConfig?: IgnoreFilesConfig;
}

// ============================================================================
// Task implementation
// ============================================================================

/**
 * {@link OrchestrationTask} for package builds.
 *
 * Initialises a shared GitService and delegates individual package builds
 * to PackageBuilder. Builders emit events directly on the shared BuildEventBus.
 */
export class BuildOrchestrationTask implements OrchestrationTask<GitService | undefined> {
  private readonly buildBus: BuildEventBus;
  private readonly logger: Logger | undefined;
  private readonly options: BuildOrchestratorOptions;
  private readonly projectDirectory: string;
  private readonly provider: ProjectDefinitionProvider;

  constructor(
    provider: ProjectDefinitionProvider,
    options: BuildOrchestratorOptions,
    logger?: Logger,
    projectDirectory: string = process.cwd(),
    buildBus?: BuildEventBus,
  ) {
    this.provider = provider;
    this.options = options;
    this.logger = logger;
    this.projectDirectory = projectDirectory;
    this.buildBus = buildBus ?? new BuildEventBus();
  }

  async processSinglePackage(
    packageName: string,
    _level: number,
    gitService: GitService | undefined,
  ): Promise<PackageResult> {
    const start = Date.now();
    const pkgLogger = this.logger?.child?.({package: packageName}) ?? this.logger;

    // Check if this package should be skipped for the current lifecycle stage
    if (LifecycleEngine.isInitialized()) {
      const lifecycle = LifecycleEngine.getInstance();
      const packageDefinition = this.provider.getPackageDefinition(packageName);
      const skipStages = packageDefinition.packageOptions?.skip ?? [];
      if (skipStages.includes(lifecycle.stage)) {
        pkgLogger?.info(`Skipping — stage '${lifecycle.stage}' is in skip list`);
        return {
          duration: 0, packageName, skipped: true, success: true,
        };
      }
    }

    const builder = new PackageBuilder(
      this.provider,
      this.options,
      pkgLogger,
      gitService,
      this.options.ignoreFilesConfig,
      this.buildBus,
    );

    let success = true;
    let skipped = false;
    let error: string | undefined;
    let pendingValidation: PendingValidationDescriptor | undefined;

    // Detect build-skip via the shared bus
    const skipHandler = (evt: any) => {
      if (evt.packageName === packageName) skipped = true;
    };

    this.buildBus.on('skip', skipHandler);

    try {
      pendingValidation = await builder.buildPackage(packageName, this.projectDirectory);
    } catch (error_) {
      success = false;
      error = error_ instanceof Error ? error_.message : String(error_);
    }

    this.buildBus.off('skip', skipHandler);

    const duration = Date.now() - start;
    return {
      duration, error, packageName, pendingValidation, skipped, success,
    };
  }

  async setup(): Promise<GitService | undefined> {
    // In dry-run mode, git service is not needed (no tagging or version bumps)
    if (this.options.mode === 'dry-run') {
      this.logger?.debug('Dry-run mode — skipping git service initialization');
      return undefined;
    }

    return GitService.initialize(this.projectDirectory, this.logger);
  }
}

// ============================================================================
// Orchestrator facade
// ============================================================================

/**
 * Orchestrates building multiple packages in parallel, respecting dependency order.
 *
 * Composes the shared {@link Orchestrator} engine with a {@link BuildOrchestrationTask}
 * to handle build-specific setup and per-package processing.
 *
 * All events are emitted on typed buses:
 * - {@link buildBus} for build domain events (start, complete, stage, analyzer, etc.)
 * - {@link orchestrationBus} for orchestration events (level start/complete, package complete)
 */
export class BuildOrchestrator {
  readonly buildBus: BuildEventBus;
  readonly orchestrationBus: OrchestrationEventBus;
  private readonly orchestrator: Orchestrator<GitService | undefined>;

  constructor(
    provider: ProjectDefinitionProvider,
    graph: ProjectGraph,
    options: BuildOrchestratorOptions,
    logger?: Logger,
    projectDirectory: string = process.cwd(),
  ) {
    this.buildBus = new BuildEventBus();
    this.orchestrationBus = new OrchestrationEventBus(randomUUID());
    const task = new BuildOrchestrationTask(provider, options, logger, projectDirectory, this.buildBus);
    this.orchestrator = new Orchestrator(graph, {...options, includeManagedPackages: false}, task, logger, this.orchestrationBus);
  }

  /**
   * Build multiple packages in dependency order.
   *
   * @param packageNames — Package names requested by the caller.
   *   When `includeDependencies` is true (default) all transitive dependencies
   *   are resolved and built first.
   * @returns OrchestrationResult with per-package outcomes.
   */
  public async buildAll(packageNames: string[]): Promise<OrchestrationResult> {
    return this.orchestrator.executeAll(packageNames);
  }
}
