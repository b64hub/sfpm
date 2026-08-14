import {randomUUID} from 'node:crypto';

import type {ProjectDefinitionProvider} from '../project/providers/project-definition-provider.js';
import type {LocalValidator} from '../types/local-validator.js';
import type {BuildOptions, BuildOrg} from '../types/package.js';

import {
  BuildEventBus,
  OrchestrationEventBus,
  OrchestrationResult,
  PackageResult,
} from '../events/index.js';
import PackageBuilder, {type PackageBuildResult} from '../package/package-builder.js';
import ProjectGraph from '../project/project-graph.js';
import Logger from '../types/logger.js';
import {
  OrchestrationTask,
  Orchestrator,
  OrchestratorOptions,
} from './orchestrator.js';

export type BuildOrchestratorOptions = BuildOptions & OrchestratorOptions;

/**
 * {@link OrchestrationTask} for package builds.
 *
 * Wraps a single, pre-configured {@link PackageBuilder} shared across every
 * package in the run — the builder holds no per-call mutable state, so this
 * is safe under the Orchestrator's intra-level concurrency. `build()` returns
 * an explicit `skipped` flag, so no event-bus listening is needed here.
 */
export class BuildOrchestrationTask implements OrchestrationTask<PackageBuildResult> {
  constructor(public readonly builder: PackageBuilder) {}

  async processSinglePackage(
    packageName: string,
    _level: number,
  ): Promise<PackageResult<PackageBuildResult>> {
    const start = Date.now();

    let success = true;
    let skipped = false;
    let error: string | undefined;
    let result: PackageBuildResult | undefined;

    try {
      result = await this.builder.build(packageName);
      skipped = result.skipped;
    } catch (error_) {
      success = false;
      error = error_ instanceof Error ? error_.message : String(error_);
    }

    const duration = Date.now() - start;
    return {
      duration, error, packageName, result, skipped, success,
    };
  }
}

// ============================================================================
// Orchestrator facade
// ============================================================================

/**
 * Orchestrates building multiple packages in parallel, respecting dependency order.
 *
 * Composes the shared {@link Orchestrator} engine with a {@link BuildOrchestrationTask}
 * wrapping one {@link PackageBuilder} instance, reused across every package in the run.
 *
 * All events are emitted on typed buses:
 * - {@link buildBus} for build domain events (start, complete, stage, analyzer, etc.)
 * - {@link orchestrationBus} for orchestration events (level start/complete, package complete)
 */
export class BuildOrchestrator {
  readonly orchestrationBus: OrchestrationEventBus<PackageBuildResult>;
  private readonly builder: PackageBuilder;
  private readonly orchestrator: Orchestrator<PackageBuildResult>;

  public constructor(
    graph: ProjectGraph,
    builder: PackageBuilder,
    options: OrchestratorOptions,
    logger?: Logger,
  ) {
    this.builder = builder;
    this.orchestrationBus = new OrchestrationEventBus(randomUUID());
    const task = new BuildOrchestrationTask(builder);
    this.orchestrator = new Orchestrator(graph, {...options, includeManagedPackages: false}, task, logger, this.orchestrationBus);
  }

  /**
   * Create an orchestrator for building packages from project source.
   * Constructs the shared PackageBuilder once; every package in the run is
   * built through that same instance. The builder owns its own BuildEventBus.
   */
  static create(
    provider: ProjectDefinitionProvider,
    buildOrg: BuildOrg | undefined,
    graph: ProjectGraph,
    options: BuildOrchestratorOptions,
    logger?: Logger,
    localValidator?: LocalValidator,
  ): BuildOrchestrator {
    const builder = new PackageBuilder(provider, buildOrg, options, logger, localValidator);
    return new BuildOrchestrator(graph, builder, options, logger);
  }

  /**
   * Build domain events (start, complete, stage, analyzer, etc.) — routes
   * straight to the shared {@link PackageBuilder}'s bus. Not a separate
   * instance: the builder and orchestrator always point at the same bus,
   * so there is nothing to keep in sync here.
   */
  get buildBus(): BuildEventBus {
    return this.builder.bus;
  }

  /**
   * Build multiple packages in dependency order.
   *
   * @param packageNames — Package names requested by the caller.
   *   When `includeDependencies` is true (default) all transitive dependencies
   *   are resolved and built first.
   * @returns OrchestrationResult with per-package outcomes.
   */
  public async buildAll(packageNames: string[]): Promise<OrchestrationResult<PackageBuildResult>> {
    return this.orchestrator.executeAll(packageNames);
  }
}
