import EventEmitter from 'node:events';

import {GitService} from '../git/git-service.js';
import ProjectConfig from '../project/project-config.js';
import {ProjectGraph} from '../project/project-graph.js';
import {
  AllBuildEvents,
  OrchestrationEvents,
  OrchestrationResult,
  PackageResult,
} from '../types/events.js';
import {Logger} from '../types/logger.js';
import {
  Orchestrator,
  OrchestratorEmitter,
  OrchestratorOptions,
  OrchestrationTask,
} from './orchestrator.js';
import {BuildOptions, PackageBuilder} from './package-builder.js';

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
  private readonly options: BuildOptions;
  private readonly projectConfig: ProjectConfig;
  private readonly projectDirectory: string;

  constructor(
    projectConfig: ProjectConfig,
    options: BuildOptions,
    logger?: Logger,
    projectDirectory: string = process.cwd(),
  ) {
    this.projectConfig = projectConfig;
    this.options = options;
    this.logger = logger;
    this.projectDirectory = projectDirectory;
  }

  async setup(): Promise<GitService | undefined> {
    return GitService.initialize(this.projectDirectory, this.logger);
  }

  async processSinglePackage(
    packageName: string,
    _level: number,
    gitService: GitService | undefined,
    emitter: OrchestratorEmitter,
  ): Promise<PackageResult> {
    const start = Date.now();

    const builder = new PackageBuilder(
      this.projectConfig,
      this.options,
      this.logger,
      gitService,
    );

    this.forwardBuilderEvents(builder, emitter);

    let success = true;
    const skipped = false;
    let error: string | undefined;

    try {
      await builder.buildPackage(packageName, this.projectDirectory);
    } catch (error_) {
      success = false;
      error = error_ instanceof Error ? error_.message : String(error_);
    }

    builder.removeAllListeners();

    const duration = Date.now() - start;
    return {duration, error, packageName, skipped, success};
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
    projectConfig: ProjectConfig,
    graph: ProjectGraph,
    options: BuildOrchestratorOptions,
    logger?: Logger,
    projectDirectory: string = process.cwd(),
  ) {
    super();
    const task = new BuildOrchestrationTask(projectConfig, options, logger, projectDirectory);
    this.orchestrator = new Orchestrator(graph, options, task, logger, this);
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
