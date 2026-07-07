import {Org} from '@salesforce/core';
import {randomUUID} from 'node:crypto';

import type {ProjectDefinitionProvider} from '../project/providers/project-definition-provider.js';

import {ApexTestService, type TestRunResult} from '../apex/apex-test-service.js';
import {ArtifactRepository} from '../artifacts/artifact-repository.js';
import {InstallEventBus} from '../events/install-event-bus.js';
import {
  OrchestrationEventBus,
  OrchestrationResult,
  PackageResult,
} from '../events/orchestration-event-bus.js';
import {LifecycleEngine} from '../lifecycle/lifecycle-engine.js';
import PackageInstaller, {InstallResult} from '../package/package-installer.js';
import {ProjectGraph} from '../project/project-graph.js';
import Logger from '../types/logger.js';
import {type InstallOptions, PackageOrigin} from '../types/package.js';
import {
  OrchestrationTask,
  Orchestrator,
  OrchestratorOptions,
} from './orchestrator.js';

// ============================================================================
// Types
// ============================================================================

export type InstallOrchestratorOptions = InstallOptions & OrchestratorOptions & {
  /** Run tests in direct dependents of installed packages after orchestration completes. */
  regressionTest?: boolean;
};

/** Regression test outcome for a single dependent package. */
export interface RegressionTestResult {
  /** Human-readable error if test run failed to execute */
  error?: string;
  /** Package whose dependents were being validated */
  installedPackage: string;
  /** The dependent package that was tested */
  packageName: string;
  /** Test results, undefined if test run failed to start */
  result?: TestRunResult;
  /** Whether all tests passed */
  success: boolean;
}

/** Extends the generic orchestration result with optional regression test outcomes. */
export interface InstallOrchestrationResult extends OrchestrationResult<InstallResult> {
  regressionTests?: RegressionTestResult[];
}

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
      const skipStages = packageDefinition?.packageOptions?.skip ?? [];
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
  private readonly graph: ProjectGraph;
  private readonly logger?: Logger;
  private readonly options: InstallOrchestratorOptions;
  private readonly orchestrator: Orchestrator<InstallResult>;
  private readonly targetOrg: Org;

  constructor(
    targetOrg: Org,
    provider: ProjectDefinitionProvider,
    graph: ProjectGraph,
    options: InstallOrchestratorOptions,
    logger?: Logger,
  ) {
    this.targetOrg = targetOrg;
    this.graph = graph;
    this.options = options;
    this.logger = logger;
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
      {...options, includeManagedPackages: true, origin: PackageOrigin.Artifact},
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
      {
        ...options, includeManagedPackages: false, origin: PackageOrigin.Local, unlocked: {sourceOnly: true},
      },
      logger,
    );
  }

  // ========================================================================
  // Public entry point
  // ========================================================================

  /**
   * Install multiple packages in dependency order.
   *
   * When `regressionTest` is enabled, runs Apex tests in direct dependents
   * of successfully installed packages after all installs complete.
   * Regression test failures are non-blocking — they are reported in
   * {@link InstallOrchestrationResult.regressionTests} without affecting
   * the orchestration `success` flag.
   *
   * @param packageNames — Package names requested by the caller.
   *   When `includeDependencies` is true (default) all transitive dependencies
   *   are resolved and installed first.
   * @returns InstallOrchestrationResult with per-package outcomes and optional regression tests.
   */
  public async installAll(packageNames: string[]): Promise<InstallOrchestrationResult> {
    const orchestrationResult = await this.orchestrator.executeAll(packageNames);

    if (!this.options.regressionTest) {
      return orchestrationResult;
    }

    const regressionTests = await this.runRegressionTests(orchestrationResult);
    return {...orchestrationResult, ...(regressionTests.length > 0 && {regressionTests})};
  }

  // ========================================================================
  // Regression testing
  // ========================================================================

  /**
   * Collect direct dependents of successfully installed packages,
   * read their test classes from artifact metadata, fire all test runs
   * concurrently, then await all results.
   */
  private async runRegressionTests(orchestrationResult: OrchestrationResult<InstallResult>): Promise<RegressionTestResult[]> {
    const installedPackages = orchestrationResult.results
    .filter(r => r.success && !r.skipped)
    .map(r => r.packageName);

    if (installedPackages.length === 0) return [];

    const dependents = this.graph.getDirectDependents(installedPackages);
    if (dependents.length === 0) return [];

    // Map installed package name for each dependent (for result attribution)
    const installedSet = new Set(installedPackages);
    const dependentEntries: Array<{installedPackage: string; packageName: string; testClasses: string[]}> = [];

    for (const dep of dependents) {
      if (!dep.path) continue;

      const repo = new ArtifactRepository(dep.path, this.logger, dep.name);
      const metadata = repo.getMetadata();
      const testClasses = (metadata as any)?.content?.apex?.tests as string[] | undefined;
      if (!testClasses?.length) continue;

      // Find which installed package this dependent consumes
      const installedPackage = [...dep.dependencies]
      .find(d => installedSet.has(d.name))?.name ?? installedPackages[0];

      dependentEntries.push({installedPackage, packageName: dep.name, testClasses});
    }

    if (dependentEntries.length === 0) return [];

    const testService = new ApexTestService(this.targetOrg.getConnection(), this.logger);

    this.logger?.info(`Regression testing ${dependentEntries.length} dependent package(s): ${dependentEntries.map(e => e.packageName).join(', ')}`);

    this.orchestrationBus.regressionStart({
      packages: dependentEntries.map(e => e.packageName),
    });

    const regressionStart = Date.now();

    // Fire all test runs concurrently
    const pending = await Promise.all(dependentEntries.map(async entry => {
      try {
        const testRunId = await testService.runTests(entry.testClasses);
        return {entry, testRunId};
      } catch (error) {
        return {entry, error: error instanceof Error ? error.message : String(error)};
      }
    }));

    // Await all results concurrently
    const results = await Promise.all(pending.map(async p => {
      if ('error' in p) {
        this.orchestrationBus.regressionPackageComplete({
          error: p.error,
          failed: 0, packageName: p.entry.packageName,
          passed: 0, success: false, total: 0,
        });
        return {
          error: p.error,
          installedPackage: p.entry.installedPackage,
          packageName: p.entry.packageName,
          success: false,
        } satisfies RegressionTestResult;
      }

      try {
        const result = await testService.awaitTests(p.testRunId);
        this.orchestrationBus.regressionPackageComplete({
          failed: result.failed, packageName: p.entry.packageName,
          passed: result.passed, success: result.failed === 0, total: result.total,
        });
        return {
          installedPackage: p.entry.installedPackage,
          packageName: p.entry.packageName,
          result,
          success: result.failed === 0,
        } satisfies RegressionTestResult;
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        this.orchestrationBus.regressionPackageComplete({
          error: msg, failed: 0, packageName: p.entry.packageName,
          passed: 0, success: false, total: 0,
        });
        return {
          error: msg,
          installedPackage: p.entry.installedPackage,
          packageName: p.entry.packageName,
          success: false,
        } satisfies RegressionTestResult;
      }
    }));

    const passed = results.filter(r => r.success).map(r => r.packageName);
    const failed = results.filter(r => !r.success).map(r => r.packageName);

    this.orchestrationBus.regressionComplete({
      duration: Date.now() - regressionStart,
      failed,
      passed,
    });

    if (failed.length > 0) {
      this.logger?.warn(`Regression tests failed in ${failed.length} package(s): ${failed.join(', ')}`);
    } else {
      this.logger?.info(`Regression tests passed in all ${results.length} dependent package(s)`);
    }

    return results;
  }
}
