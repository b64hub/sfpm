import {Org} from '@salesforce/core';
import {randomUUID} from 'node:crypto';

import type {ProjectDefinitionProvider} from '../project/providers/project-definition-provider.js';

import {InstallEventBus} from '../events/install-event-bus.js';
import {
  OrchestrationEventBus,
  OrchestrationResult,
  PackageResult,
} from '../events/orchestration-event-bus.js';
import {LifecycleEngine} from '../lifecycle/lifecycle-engine.js';
import PackageInstaller, {InstallOptions, InstallResult} from '../package/package-installer.js';
import PackageManager from '../package/package-manager.js';
import {ProjectGraph} from '../project/project-graph.js';
import {Logger} from '../types/logger.js';
import {InstallationSource} from '../types/package.js';
import {
  OrchestrationTask,
  Orchestrator,
  OrchestratorOptions,
} from './orchestrator.js';

export type InstallOrchestratorOptions = InstallOptions & OrchestratorOptions;

/**
 * {@link OrchestrationTask} for package installations.
 *
 * Creates a shared Org connection and pre-cached ArtifactService, then
 * delegates individual package installs to PackageInstaller.
 * Installers emit events directly on the shared InstallEventBus.
 */
export class InstallOrchestrationTask implements OrchestrationTask<InstallResult> {
  private readonly installBus: InstallEventBus;
  private readonly logger?: Logger;
  private readonly options: InstallOrchestratorOptions;
  private readonly provider: ProjectDefinitionProvider;
  private readonly targetOrg: Org;

  constructor(
    targetOrg: Org,
    provider: ProjectDefinitionProvider,
    options: InstallOrchestratorOptions,
    logger?: Logger,
    installBus?: InstallEventBus,
  ) {
    this.targetOrg = targetOrg;
    this.provider = provider;
    this.options = options;
    this.logger = logger;
    this.installBus = installBus ?? new InstallEventBus();
  }

  async processSinglePackage(
    packageName: string,
    _level: number,
  ): Promise<PackageResult<InstallResult>> {
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

    const installer = new PackageInstaller(
      this.targetOrg,
      this.provider,
      this.options,
      pkgLogger,
      this.installBus,
    );

    let success = true;
    let skipped = false;
    let error: string | undefined;
    let result: InstallResult | undefined;

    try {
      result = await installer.install(packageName);
      if (result.skipped) {
        skipped = true;
      }
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
 * Orchestrates installing multiple packages in parallel, respecting dependency order.
 *
 * Composes the shared {@link Orchestrator} engine with an {@link InstallOrchestrationTask}
 * to handle install-specific setup and per-package processing.
 *
 * All events are emitted on typed buses:
 * - {@link installBus} for install domain events (start, complete, deploy, version, etc.)
 * - {@link orchestrationBus} for orchestration events (level start/complete, package complete)
 */
export class InstallOrchestrator {
  readonly installBus: InstallEventBus;
  readonly orchestrationBus: OrchestrationEventBus<InstallResult>;
  private readonly orchestrator: Orchestrator<InstallResult>;

  constructor(
    targetOrg: Org,
    provider: ProjectDefinitionProvider,
    graph: ProjectGraph,
    options: InstallOrchestratorOptions,
    logger?: Logger,
  ) {
    this.installBus = new InstallEventBus();
    this.orchestrationBus = new OrchestrationEventBus(randomUUID());
    const task = new InstallOrchestrationTask(targetOrg, provider, options, logger, this.installBus);
    this.orchestrator = new Orchestrator(graph, options, task, logger, this.orchestrationBus);
  }

  // ========================================================================
  // Static factory methods
  // ========================================================================

  /**
   * Create an orchestrator for installing from built artifacts.
   * Uses artifact resolution (local or npm) to find the best version.
   */
  static forArtifact(
    targetOrg: Org,
    provider: ProjectDefinitionProvider,
    graph: ProjectGraph,
    options: Omit<InstallOrchestratorOptions, 'source'> & {source?: never},
    logger?: Logger,
  ): InstallOrchestrator {
    return new InstallOrchestrator(
      targetOrg,
      provider,
      graph,
      {...options, includeManagedPackages: true, source: InstallationSource.Artifact},
      logger,
    );
  }

  /**
   * Create an orchestrator for installing directly from project source.
   * Deploys source metadata via the metadata API without artifact resolution.
   */
  static forSource(
    targetOrg: Org,
    provider: ProjectDefinitionProvider,
    graph: ProjectGraph,
    options: Omit<InstallOrchestratorOptions, 'mode' | 'source'> & {mode?: never; source?: never},
    logger?: Logger,
  ): InstallOrchestrator {
    return new InstallOrchestrator(
      targetOrg,
      provider,
      graph,
      {...options, includeManagedPackages: false, source: InstallationSource.Local},
      logger,
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
  public async installAll(packageNames: string[]): Promise<OrchestrationResult<InstallResult>> {
    return this.orchestrator.executeAll(packageNames);
  }
}
