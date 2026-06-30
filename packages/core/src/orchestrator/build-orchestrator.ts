import {randomUUID} from 'node:crypto';

import LifecycleEngine from '../lifecycle/lifecycle-engine.js';
import PackageBuilder from '../package/package-builder.js';
import ProjectGraph from '../project/project-graph.js';
import Logger from '../types/logger.js';
import {
  BuildEventBus, 
  OrchestrationEventBus, 
  OrchestrationResult,
  PackageResult,
} from '../events/index.js';
import {
  OrchestrationTask,
  Orchestrator,
  OrchestratorOptions,
} from './orchestrator.js';

import type {PendingValidationDescriptor} from '../types/validation.js';
import type { BuildOptions } from '../types/package.js';
import type {ProjectDefinitionProvider} from '../project/providers/project-definition-provider.js';

export type BuildOrchestratorOptions = BuildOptions & OrchestratorOptions;

/**
 * {@link OrchestrationTask} for package builds.
 *
 * Delegates individual package builds to PackageBuilder.
 * Builders emit events directly on the shared BuildEventBus.
 */
export class BuildOrchestrationTask implements OrchestrationTask<PendingValidationDescriptor> {
  private readonly buildBus: BuildEventBus;
  private readonly options: BuildOrchestratorOptions;
  private readonly provider: ProjectDefinitionProvider;
  private readonly logger?: Logger;

  constructor(
    provider: ProjectDefinitionProvider,
    options: BuildOrchestratorOptions,
    logger?: Logger,
    buildBus?: BuildEventBus,
  ) {
    this.provider = provider;
    this.options = options;
    this.logger = logger;
    this.buildBus = buildBus ?? new BuildEventBus();
  }

  async processSinglePackage(
    packageName: string,
    _level: number,
  ): Promise<PackageResult<PendingValidationDescriptor>> {
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
      pendingValidation = await builder.build(packageName);
    } catch (error_) {
      success = false;
      error = error_ instanceof Error ? error_.message : String(error_);
    }

    this.buildBus.off('skip', skipHandler);

    const duration = Date.now() - start;
    return {
      duration, error, packageName, result: pendingValidation, skipped, success,
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
 * to handle build-specific setup and per-package processing.
 *
 * All events are emitted on typed buses:
 * - {@link buildBus} for build domain events (start, complete, stage, analyzer, etc.)
 * - {@link orchestrationBus} for orchestration events (level start/complete, package complete)
 */
export class BuildOrchestrator {
  readonly buildBus: BuildEventBus;
  readonly orchestrationBus: OrchestrationEventBus<PendingValidationDescriptor>;
  private readonly orchestrator: Orchestrator<PendingValidationDescriptor>;

  constructor(
    provider: ProjectDefinitionProvider,
    graph: ProjectGraph,
    options: BuildOrchestratorOptions,
    logger?: Logger,
  ) {
    this.buildBus = new BuildEventBus();
    this.orchestrationBus = new OrchestrationEventBus(randomUUID());
    const task = new BuildOrchestrationTask(provider, options, logger, this.buildBus);
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
  public async buildAll(packageNames: string[]): Promise<OrchestrationResult<PendingValidationDescriptor>> {
    return this.orchestrator.executeAll(packageNames);
  }
}
