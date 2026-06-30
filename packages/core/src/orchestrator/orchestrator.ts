import {randomUUID} from 'node:crypto';

import {
  OrchestrationEventBus,
  OrchestrationResult,
  PackageResult,
} from '../events/orchestration-event-bus.js';
import {DependencyResolution, PackageNode, ProjectGraph} from '../project/project-graph.js';
import {DependencyError} from '../types/errors.js';
import {Logger} from '../types/logger.js';

// ============================================================================
// Public types
// ============================================================================

export interface OrchestratorOptions {
  /** Continue orchestration even if a package fails. Defaults to false (fail fast). */
  continueOnError?: boolean;
  /** Include transitive dependencies. Defaults to true. */
  includeDependencies?: boolean;
  /** Include managed (external) packages in orchestration. Defaults to true. */
  includeManagedPackages?: boolean;
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
export interface OrchestrationTask<TResult = void> {
  /**
   * Process a single package. Must return a {@link PackageResult}.
   *
   * Implementations should catch their own errors and return a failed result
   * rather than throwing. Domain-specific events are emitted via the shared
   * event bus — no forwarding through the orchestrator needed.
   */
  processSinglePackage(
    packageName: string,
    level: number,
  ): Promise<PackageResult<TResult>>;
}

// ============================================================================
// Internal types
// ============================================================================

/**
 * Mutable state accumulated while iterating through dependency levels.
 */
interface LevelTracker<TResult> {
  failedPackages: Set<string>;
  results: PackageResult<TResult>[];
  skippedPackages: Set<string>;
}

/**
 * Categorised outcome of a single dependency level.
 */
interface LevelOutcome<TResult> {
  failed: string[];
  results: PackageResult<TResult>[];
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
 * Orchestration events are emitted through the {@link OrchestrationEventBus}.
 *
 * @typeParam TContext — Shared context created by the task's `setup()` call.
 */
export class Orchestrator<TResult = void> {
  readonly bus: OrchestrationEventBus;
  private readonly graph: ProjectGraph;
  private readonly logger: Logger | undefined;
  private readonly options: OrchestratorOptions;
  private readonly task: OrchestrationTask<TResult>;

  constructor(
    graph: ProjectGraph,
    options: OrchestratorOptions,
    task: OrchestrationTask<TResult>,
    logger?: Logger,
    bus?: OrchestrationEventBus,
  ) {
    this.graph = graph;
    this.options = options;
    this.task = task;
    this.logger = logger;
    this.bus = bus ?? new OrchestrationEventBus(randomUUID());
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
  public async executeAll(packageNames: string[]): Promise<OrchestrationResult<TResult>> {
    if (packageNames.length === 0) {
      return {
        duration: 0,
        failedPackages: [],
        pendingValidations: [],
        results: [],
        skippedPackages: [],
        success: true,
      };
    }

    const orchestrationStart = Date.now();
    const includeDeps = this.options.includeDependencies !== false;

    const levels = this.resolveLevels(packageNames);
    this.emitOrchestrationStart(levels, includeDeps);

    const tracker: LevelTracker<TResult> = {
      failedPackages: new Set(),
      results: [],
      skippedPackages: new Set(),
    };

    for (const [levelIndex, level] of levels.entries()) {
      // eslint-disable-next-line no-await-in-loop
      await this.processLevel(level, levelIndex, tracker);
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
    tracker: LevelTracker<TResult>,
    orchestrationStart: number,
  ): OrchestrationResult<TResult> {
    const totalDuration = Date.now() - orchestrationStart;

    // Collect pending validations from all successful package results
    const pendingValidations = tracker.results
    .filter(r => r.pendingValidation)
    .map(r => r.pendingValidation!);

    const result: OrchestrationResult<TResult> = {
      duration: totalDuration,
      failedPackages: [...tracker.failedPackages],
      pendingValidations,
      results: tracker.results,
      skippedPackages: [...tracker.skippedPackages],
      success: tracker.failedPackages.size === 0,
    };

    this.bus.complete({
      results: tracker.results,
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
    settled: PromiseSettledResult<PackageResult<TResult>>[],
    eligible: PackageNode[],
    level: PackageNode[],
    tracker: LevelTracker<TResult>,
  ): LevelOutcome<TResult> {
    const succeeded: string[] = [];
    const failed: string[] = [];
    const skipped: string[] = [...tracker.skippedPackages].filter(s => level.some(n => n.name === s));

    for (const [i, outcome] of settled.entries()) {
      const pkgName = eligible[i].name;

      if (outcome.status === 'fulfilled') {
        tracker.results.push(outcome.value);
        if (outcome.value.skipped) {
          skipped.push(pkgName);
        } else if (outcome.value.success) {
          succeeded.push(pkgName);
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
    this.bus.start({
      includeDependencies,
      packageNames: levels.flat().map(n => n.name),
      totalLevels: levels.length,
      totalPackages: levels.reduce((sum, l) => sum + l.length, 0),
    });
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
    tracker: LevelTracker<TResult>,
  ): Promise<void> {
    const eligible = this.skipFailedDependents(level, levelIndex, tracker);
    if (eligible.length === 0) return;

    this.bus.levelStart({
      level: levelIndex,
      packageDetails: eligible.map(n => ({isManaged: n.isManaged, name: n.name, version: n.version})),
      packages: eligible.map(n => n.name),
    });

    const settled = await Promise.allSettled(eligible.map(node => this.processPackageWithTracking(node.name, levelIndex)));

    const outcome = this.collectLevelResults(settled, eligible, level, tracker);

    this.bus.levelComplete({
      failed: outcome.failed,
      level: levelIndex,
      skipped: outcome.skipped,
      succeeded: outcome.succeeded,
    });
  }

  /**
   * Wrap the task's processSinglePackage call with error handling and
   * automatic orchestration:package:complete emission.
   */
  private async processPackageWithTracking(
    packageName: string,
    level: number,
  ): Promise<PackageResult<TResult>> {
    let result: PackageResult<TResult>;

    try {
      result = await this.task.processSinglePackage(packageName, level);
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

    this.bus.packageComplete({
      duration: result.duration,
      error: result.error,
      level,
      packageName,
      skipped: result.skipped,
      success: result.success,
    });

    return result;
  }

  /**
   * Resolve the dependency graph, validate it, and return the ordered levels.
   * Throws DependencyError if circular dependencies are detected.
   * Filters out unrequested packages when `includeDependencies` is false.
   */
  private resolveLevels(packageNames: string[]): PackageNode[][] {
    const includeManaged = this.options.includeManagedPackages !== false;
    const includeDeps = this.options.includeDependencies !== false;

    if (!includeDeps && packageNames.length === 1) {
      return [[this.graph.getNode(packageNames[0])!]];
    }

    const resolution = this.graph.resolveDependencies(packageNames, {includeManaged});
    this.checkCircularDependencies(resolution, packageNames);

    let {levels} = resolution;

    if (!includeDeps) {
      levels = this.filterToRequestedPackages(levels, packageNames);
    }

    return levels;
  }

  /**
   * Filter out packages whose dependencies have already failed, marking them
   * as skipped. Returns only the eligible nodes that should proceed.
   */
  private skipFailedDependents(
    level: PackageNode[],
    levelIndex: number,
    tracker: LevelTracker<TResult>,
  ): PackageNode[] {
    if (this.options.continueOnError) {
      return level;
    }

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
      this.bus.packageComplete({
        duration: 0,
        error: 'Skipped because a dependency failed',
        level: levelIndex,
        packageName: node.name,
        skipped: true,
        success: false,
      });
      return false;
    });
  }
}
