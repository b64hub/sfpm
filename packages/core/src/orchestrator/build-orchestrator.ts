import EventEmitter from 'node:events';

import type {ProjectDefinitionProvider} from '../project/providers/project-definition-provider.js';

import {GitService} from '../git/git-service.js';
import {LifecycleEngine} from '../lifecycle/lifecycle-engine.js';
import {BuildOptions, PackageBuilder} from '../package/package-builder.js';
import {ProjectGraph} from '../project/project-graph.js';
import {
  AllBuildEvents,
  OrchestrationEvents,
  OrchestrationResult,
  PackageResult,
} from '../types/events.js';
import {Logger} from '../types/logger.js';
import {
  OrchestrationTask,
  Orchestrator,
  OrchestratorEmitter,
  OrchestratorOptions,
} from './orchestrator.js';

export interface BuildOrchestratorOptions extends BuildOptions, OrchestratorOptions {}

// ============================================================================
// Task implementation
// ============================================================================

/**
 * {@link OrchestrationTask} for package builds.
 *
 * Initialises a shared GitService and delegates individual package builds
 * to PackageBuilder, forwarding all builder events through the emitter.
 */
export class BuildOrchestrationTask implements OrchestrationTask<GitService | undefined> {
  private readonly logger: Logger | undefined;
  private readonly options: BuildOrchestratorOptions;
  private readonly projectDirectory: string;
  private readonly provider: ProjectDefinitionProvider;

  constructor(
    provider: ProjectDefinitionProvider,
    options: BuildOrchestratorOptions,
    logger?: Logger,
    projectDirectory: string = process.cwd(),
  ) {
    this.provider = provider;
    this.options = options;
    this.logger = logger;
    this.projectDirectory = projectDirectory;
  }

  async processSinglePackage(
    packageName: string,
    _level: number,
    gitService: GitService | undefined,
    emitter: OrchestratorEmitter,
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
    );

    this.forwardBuilderEvents(builder, emitter);

    let success = true;
    let skipped = false;
    let error: string | undefined;

    // Detect build-skip before the call so the flag is captured
    builder.on('build:skipped', () => {
      skipped = true;
    });

    try {
      await builder.buildPackage(packageName, this.projectDirectory);
    } catch (error_) {
      success = false;
      error = error_ instanceof Error ? error_.message : String(error_);
    }

    builder.removeAllListeners();

    const duration = Date.now() - start;
    return {
      duration, error, packageName, skipped, success,
    };
  }

  async setup(): Promise<GitService | undefined> {
    // In validate mode, git service is not needed (no tagging or version bumps)
    if (this.options.mode === 'validate') {
      this.logger?.debug('Validate mode — skipping git service initialization');
      return undefined;
    }

    return GitService.initialize(this.projectDirectory, this.logger);
  }

  private forwardBuilderEvents(builder: PackageBuilder, emitter: OrchestratorEmitter): void {
    const events: (keyof AllBuildEvents)[] = [
      'build:start',
      'build:complete',
      'build:skipped',
      'build:error',
      'stage:start',
      'stage:complete',
      'analyzers:start',
      'analyzer:start',
      'analyzer:complete',
      'analyzers:complete',
      'connection:start',
      'connection:complete',
      'builder:start',
      'builder:complete',
      'task:start',
      'task:complete',
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
      'assembly:start',
      'assembly:pack',
      'assembly:complete',
      'assembly:error',
    ];

    for (const event of events) {
      builder.on(event, (...args: any[]) => {
        emitter.emit(event, ...args);
      });
    }
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
 * All builder and orchestration events are emitted through this instance,
 * so callers can subscribe with `orchestrator.on(event, handler)`.
 */
export class BuildOrchestrator extends EventEmitter<AllBuildEvents & OrchestrationEvents> {
  private readonly orchestrator: Orchestrator<GitService | undefined>;

  constructor(
    provider: ProjectDefinitionProvider,
    graph: ProjectGraph,
    options: BuildOrchestratorOptions,
    logger?: Logger,
    projectDirectory: string = process.cwd(),
  ) {
    super();
    const task = new BuildOrchestrationTask(provider, options, logger, projectDirectory);
    this.orchestrator = new Orchestrator(graph, {...options, includeManagedPackages: false}, task, logger, this);
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
