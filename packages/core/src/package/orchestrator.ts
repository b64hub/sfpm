import EventEmitter from 'node:events';

import {DependencyResolution, PackageNode, ProjectGraph} from '../project/project-graph.js';
import {DependencyError} from '../types/errors.js';
import {
  OrchestrationResult,
  PackageResult,
} from '../types/events.js';
import {Logger} from '../types/logger.js';

// ============================================================================
// Public types
// ============================================================================

export interface OrchestratorOptions {
  /** Include transitive dependencies. Defaults to true. */
  includeDependencies?: boolean;
  /** Include managed (external) packages in orchestration. Defaults to true. */
  includeManagedPackages?: boolean;
}

/**
 * Minimal event-emitting contract used by {@link OrchestrationTask} implementations
 * to forward domain-specific events (build, install, etc.) through the
 * orchestrator's event bus.
 */
export interface OrchestratorEmitter {
  emit(eventName: string | symbol, ...args: any[]): boolean;
}

/**
 * Pluggable strategy for domain-specific work within an orchestration run.
 *
 * Implementations provide one-time setup (e.g. Org connection, GitService)
 * and per-package processing (build, install). The {@link Orchestrator}
 * handles dependency resolution, level-based concurrency, and failure
 * propagation.
 *
 * @typeParam TContext — Shared context type returned by `setup()` and threaded
 *   to each `processSinglePackage()` call.
 */
export interface OrchestrationTask<TContext = void> {
  /**
   * Process a single package. Must return a {@link PackageResult}.
   *
   * Implementations should catch their own errors and return a failed result
   * rather than throwing. Domain-specific events (build, install, etc.) should
   * be forwarded through the provided `emitter`.
   */
  processSinglePackage(
    packageName: string,
    level: number,
    context: TContext,
    emitter: OrchestratorEmitter,
  ): Promise<PackageResult>;

  /**
   * One-time initialisation before level processing begins.
   * The returned context is shared across all `processSinglePackage` calls.
   */
  setup(): Promise<TContext>;
}

// ============================================================================
// Internal types
// ============================================================================

/**
 * Mutable state accumulated while iterating through dependency levels.
 */
interface LevelTracker {
  failedPackages: Set<string>;
  results: PackageResult[];
  skippedPackages: Set<string>;
}

/**
 * Categorised outcome of a single dependency level.
 */
interface LevelOutcome {
  failed: string[];
  results: PackageResult[];
  skipped: string[];
  succeeded: string[];
}

// ============================================================================
// Orchestrator
// ============================================================================

/**
 * Dependency-aware orchestration engine.
 *
 * Resolves transitive dependencies via {@link ProjectGraph}, processes packages
 * in level order with intra-level concurrency (`Promise.allSettled`), and
 * propagates failures to skip dependents.
 *
 * Domain-specific behaviour is supplied via an {@link OrchestrationTask}.
 * All orchestration and domain events are emitted through the provided
 * {@link OrchestratorEmitter}.
 *
 * @typeParam TContext — Shared context created by the task's `setup()` call.
 */
export class Orchestrator<TContext = void> {
  private readonly emitter: OrchestratorEmitter;
  private readonly graph: ProjectGraph;
  private readonly logger: Logger | undefined;
  private readonly options: OrchestratorOptions;
  private readonly task: OrchestrationTask<TContext>;

  constructor(
    graph: ProjectGraph,
    options: OrchestratorOptions,
    task: OrchestrationTask<TContext>,
    logger?: Logger,
    emitter: OrchestratorEmitter = new EventEmitter(),
  ) {
    this.graph = graph;
    this.options = options;
    this.task = task;
    this.logger = logger;
    this.emitter = emitter;
  }

  // ========================================================================
  // Public entry point
  // ========================================================================

  /**
   * Execute orchestration for the given package names.
   *
   * When `includeDependencies` is true (default) all transitive dependencies
   * are resolved and processed first.
   *
   * @returns OrchestrationResult with per-package outcomes.
   */
  public async executeAll(packageNames: string[]): Promise<OrchestrationResult> {
    const orchestrationStart = Date.now();
    const includeDeps = this.options.includeDependencies !== false;

    const levels = this.resolveLevels(packageNames);
    this.emitOrchestrationStart(levels, includeDeps);

    const context = await this.task.setup();

    const tracker: LevelTracker = {
      failedPackages: new Set(),
      results: [],
      skippedPackages: new Set(),
    };

    for (const [levelIndex, level] of levels.entries()) {
      // eslint-disable-next-line no-await-in-loop
      await this.processLevel(level, levelIndex, tracker, context);
    }

    return this.buildOrchestrationResult(tracker, orchestrationStart);
  }

  // ========================================================================
  // Dependency resolution
  // ========================================================================

  /**
   * Build the final OrchestrationResult, emit orchestration:complete, and return.
   */
  private buildOrchestrationResult(
    tracker: LevelTracker,
    orchestrationStart: number,
  ): OrchestrationResult {
    const totalDuration = Date.now() - orchestrationStart;
    const result: OrchestrationResult = {
      duration: totalDuration,
      failedPackages: [...tracker.failedPackages],
      results: tracker.results,
      skippedPackages: [...tracker.skippedPackages],
      success: tracker.failedPackages.size === 0,
    };

    this.emitter.emit('orchestration:complete', {
      results: tracker.results,
      timestamp: new Date(),
      totalDuration,
    });

    return result;
  }

  /**
   * Throw a DependencyError when the resolution contains cycles.
   */
  private checkCircularDependencies(resolution: DependencyResolution, packageNames: string[]): void {
    if (resolution.circularDependencies) {
      const cycles = resolution.circularDependencies.map(c => c.join(' -> '));
      throw new DependencyError(
        packageNames.join(', '),
        cycles,
        `Circular dependencies detected: ${cycles.join('; ')}`,
      );
    }
  }

  /**
   * Categorise Promise.allSettled outcomes into succeeded / failed / skipped
   * lists and append results to the tracker.
   */
  private collectLevelResults(
    settled: PromiseSettledResult<PackageResult>[],
    eligible: PackageNode[],
    level: PackageNode[],
    tracker: LevelTracker,
  ): LevelOutcome {
    const succeeded: string[] = [];
    const failed: string[] = [];
    const skipped: string[] = [...tracker.skippedPackages].filter(s => level.some(n => n.name === s));

    for (const [i, outcome] of settled.entries()) {
      const pkgName = eligible[i].name;

      if (outcome.status === 'fulfilled') {
        tracker.results.push(outcome.value);
        if (outcome.value.success) {
          succeeded.push(pkgName);
        } else if (outcome.value.skipped) {
          skipped.push(pkgName);
        } else {
          tracker.failedPackages.add(pkgName);
          failed.push(pkgName);
        }
      } else {
        const errorMessage = outcome.reason instanceof Error
          ? outcome.reason.message
          : String(outcome.reason);
        tracker.failedPackages.add(pkgName);
        failed.push(pkgName);
        tracker.results.push({
          duration: 0,
          error: errorMessage,
          packageName: pkgName,
          skipped: false,
          success: false,
        });
      }
    }

    return {
      failed, results: tracker.results, skipped, succeeded,
    };
  }

  // ========================================================================
  // Level processing
  // ========================================================================

  /**
   * Emit the orchestration:start event with totals computed from the resolved levels.
   */
  private emitOrchestrationStart(levels: PackageNode[][], includeDependencies: boolean): void {
    this.emitter.emit('orchestration:start', {
      includeDependencies,
      packageNames: levels.flat().map(n => n.name),
      timestamp: new Date(),
      totalLevels: levels.length,
      totalPackages: levels.reduce((sum, l) => sum + l.length, 0),
    });
  }

  /**
   * Remove managed packages from the levels, then drop any empty levels.
   */
  private filterOutManagedPackages(levels: PackageNode[][]): PackageNode[][] {
    return levels
    .map(level => level.filter(node => !node.isManaged))
    .filter(level => level.length > 0);
  }

  /**
   * Remove packages not explicitly requested, then drop any empty levels.
   */
  private filterToRequestedPackages(levels: PackageNode[][], packageNames: string[]): PackageNode[][] {
    const requestedSet = new Set(packageNames);
    return levels
    .map(level => level.filter(node => requestedSet.has(node.name)))
    .filter(level => level.length > 0);
  }

  /**
   * Process a single dependency level: skip dependents of failed packages,
   * process eligible packages concurrently, and collect results.
   */
  private async processLevel(
    level: PackageNode[],
    levelIndex: number,
    tracker: LevelTracker,
    context: TContext,
  ): Promise<void> {
    const eligible = this.skipFailedDependents(level, levelIndex, tracker);
    if (eligible.length === 0) return;

    this.emitter.emit('orchestration:level:start', {
      level: levelIndex,
      packageDetails: eligible.map(n => ({isManaged: n.isManaged, name: n.name, version: n.version})),
      packages: eligible.map(n => n.name),
      timestamp: new Date(),
    });

    const settled = await Promise.allSettled(eligible.map(node => this.processPackageWithTracking(node.name, levelIndex, context)));

    const outcome = this.collectLevelResults(settled, eligible, level, tracker);

    this.emitter.emit('orchestration:level:complete', {
      failed: outcome.failed,
      level: levelIndex,
      skipped: outcome.skipped,
      succeeded: outcome.succeeded,
      timestamp: new Date(),
    });
  }

  /**
   * Wrap the task's processSinglePackage call with error handling and
   * automatic orchestration:package:complete emission.
   */
  private async processPackageWithTracking(
    packageName: string,
    level: number,
    context: TContext,
  ): Promise<PackageResult> {
    let result: PackageResult;

    try {
      result = await this.task.processSinglePackage(packageName, level, context, this.emitter);
    } catch (error_) {
      const errorMessage = error_ instanceof Error ? error_.message : String(error_);
      result = {
        duration: 0,
        error: errorMessage,
        packageName,
        skipped: false,
        success: false,
      };
    }

    this.emitter.emit('orchestration:package:complete', {
      duration: result.duration,
      error: result.error,
      level,
      packageName,
      skipped: result.skipped,
      success: result.success,
      timestamp: new Date(),
    });

    return result;
  }

  /**
   * Resolve the dependency graph, validate it, and return the ordered levels.
   * Throws DependencyError if circular dependencies are detected.
   * Filters out unrequested packages when `includeDependencies` is false.
   */
  private resolveLevels(packageNames: string[]): PackageNode[][] {
    const resolution = this.graph.resolveDependencies(packageNames);

    this.checkCircularDependencies(resolution, packageNames);

    let {levels} = resolution;

    if (this.options.includeDependencies === false) {
      levels = this.filterToRequestedPackages(levels, packageNames);
    }

    if (this.options.includeManagedPackages === false) {
      levels = this.filterOutManagedPackages(levels);
    }

    return levels;
  }

  // ========================================================================
  // Infrastructure
  // ========================================================================

  /**
   * Filter out packages whose dependencies have already failed, marking them
   * as skipped. Returns only the eligible nodes that should proceed.
   */
  private skipFailedDependents(
    level: PackageNode[],
    levelIndex: number,
    tracker: LevelTracker,
  ): PackageNode[] {
    return level.filter(node => {
      const hasFailedDep = [...node.dependencies].some(dep => tracker.failedPackages.has(dep.name));
      if (!hasFailedDep) return true;

      tracker.skippedPackages.add(node.name);
      tracker.results.push({
        duration: 0,
        error: 'Skipped because a dependency failed',
        packageName: node.name,
        skipped: true,
        success: false,
      });
      this.emitter.emit('orchestration:package:complete', {
        duration: 0,
        error: 'Skipped because a dependency failed',
        level: levelIndex,
        packageName: node.name,
        skipped: true,
        success: false,
        timestamp: new Date(),
      });
      return false;
    });
  }
}
