import {Org} from '@salesforce/core';
import {randomUUID} from 'node:crypto';

import type {ProjectDefinitionProvider} from '../project/providers/project-definition-provider.js';

import {ApexTestService, type TestRunResult} from '../apex/apex-test-service.js';
import {ArtifactRepository} from '../artifacts/artifact-repository.js';
import {InstallEventBus} from '../events/install-event-bus.js';
import {
  type ErrorDetail,
  extractErrorDetails,
  OrchestrationEventBus,
  OrchestrationResult,
  PackageResult,
} from '../events/orchestration-event-bus.js';
import PackageInstaller, {InstallResult} from '../package/package-installer.js';
import {ProjectGraph} from '../project/project-graph.js';
import {ArtifactProvider} from '../project/providers/artifact-provider.js';
import Logger from '../types/logger.js';
import {type InstallOptions} from '../types/package.js';
import {
  OrchestrationTask, Orchestrator, OrchestratorOptions,
} from './orchestrator.js';

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

export type InstallOrchestratorOptions = InstallOptions & OrchestratorOptions;

/**
 * {@link OrchestrationTask} for package installations.
 *
 * Creates a shared Org connection and pre-cached ArtifactService, then
 * delegates individual package installs to PackageInstaller.
 * Installers emit events directly on the shared InstallEventBus.
 */
export class InstallOrchestrationTask implements OrchestrationTask<InstallResult> {
  constructor(public readonly installer: PackageInstaller) {}

  async processSinglePackage(packageName: string, _level: number): Promise<PackageResult<InstallResult>> {
    const start = Date.now();

    let success = true;
    let skipped = false;
    let error: string | undefined;
    let errorDetails: ErrorDetail[] | undefined;
    let result: InstallResult | undefined;

    try {
      result = await this.installer.install(packageName);
      if (result?.skipped) {
        skipped = true;
      }
    } catch (error_) {
      success = false;
      error = error_ instanceof Error ? error_.message : String(error_);
      errorDetails = extractErrorDetails(error_);
    }

    const duration = Date.now() - start;
    return {
      duration,
      error,
      errorDetails,
      packageName,
      result,
      skipped,
      success,
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
 * wrapping one {@link PackageInstaller} instance, reused across every package in the run.
 *
 * All events are emitted on typed buses:
 * - {@link installBus} for install domain events (start, complete, deploy, version, etc.)
 * - {@link orchestrationBus} for orchestration events (level start/complete, package complete)
 */
export class InstallOrchestrator {
  readonly orchestrationBus: OrchestrationEventBus<InstallResult>;
  private readonly installer: PackageInstaller;
  private readonly orchestrator: Orchestrator<InstallResult>;

  constructor(graph: ProjectGraph, installer: PackageInstaller, options: OrchestratorOptions, logger?: Logger) {
    this.installer = installer;
    this.orchestrationBus = new OrchestrationEventBus(randomUUID());
    const task = new InstallOrchestrationTask(installer);

    this.orchestrator = new Orchestrator(graph, options, task, logger, this.orchestrationBus);
  }

  /**
   * Create an orchestrator for installing from built artifacts.
   * Uses artifact resolution to find the best version.
   */
  static forArtifact(
    targetOrg: Org,
    provider: ProjectDefinitionProvider,
    graph: ProjectGraph,
    options: InstallOrchestratorOptions,
    logger?: Logger,
  ): InstallOrchestrator {
    const installer = new PackageInstaller(targetOrg, provider, options, logger);
    return new InstallOrchestrator(graph, installer, {...options, includeManagedPackages: true}, logger);
  }

  // ========================================================================
  // Static factory methods
  // ========================================================================

  /**
   * Create an orchestrator for installing directly from project source.
   * Deploys source metadata via the metadata API without artifact resolution.
   */
  static forSource(
    targetOrg: Org,
    provider: ProjectDefinitionProvider,
    graph: ProjectGraph,
    options: InstallOrchestratorOptions,
    logger?: Logger,
  ): InstallOrchestrator {
    if (provider instanceof ArtifactProvider) {
      throw new TypeError('InstallOrchestrator.forSource() requires a project-source provider, not an ArtifactProvider. Use forArtifact() to install from node_modules artifacts.');
    }

    const installer = new PackageInstaller(targetOrg, provider, {...options, unlocked: {sourceOnly: true}}, logger);
    return new InstallOrchestrator(graph, installer, {...options, includeManagedPackages: false}, logger);
  }

  /**
   * Install domain events (start, complete, deploy, version, etc.) --
   * routes straight to the shared {@link PackageInstaller}'s bus. Not a
   * separate instance: the installer and orchestrator always point at the
   * same bus, so there is nothing to keep in sync here.
   */
  get installBus(): InstallEventBus {
    return this.installer.bus;
  }

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
  public async installAll(
    packageNames: string[],
    options?: {regressionTest: boolean},
  ): Promise<InstallOrchestrationResult> {
    const orchestrationResult = await this.orchestrator.executeAll(packageNames);

    if (!options?.regressionTest) {
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
  private async runRegressionTests(
    orchestrationResult: OrchestrationResult<InstallResult>,
    logger?: Logger,
  ): Promise<RegressionTestResult[]> {
    const installedPackages = orchestrationResult.results
    .filter(r => r.success && !r.skipped)
    .map(r => r.packageName);

    if (installedPackages.length === 0) return [];

    const dependents = this.orchestrator.graph.getDirectDependents(installedPackages);
    if (dependents.length === 0) return [];

    // Map installed package name for each dependent (for result attribution)
    const installedSet = new Set(installedPackages);
    const dependentEntries: Array<{installedPackage: string; packageName: string; testClasses: string[]}> = [];

    for (const dep of dependents) {
      if (!dep.path) continue;

      const repo = new ArtifactRepository(dep.path, logger, dep.name);
      const metadata = repo.getMetadata();
      const testClasses = (metadata as any)?.content?.apex?.tests as string[] | undefined;
      if (!testClasses?.length) continue;

      // Find which installed package this dependent consumes
      const installedPackage
        = [...dep.dependencies].find(d => installedSet.has(d.name))?.name ?? installedPackages[0];

      dependentEntries.push({installedPackage, packageName: dep.name, testClasses});
    }

    if (dependentEntries.length === 0) return [];

    const testService = new ApexTestService(this.installer.targetOrg.getConnection(), logger);

    logger?.info(`Regression testing ${dependentEntries.length} dependent package(s): ${dependentEntries.map(e => e.packageName).join(', ')}`);

    this.orchestrator.bus.regressionStart({
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
        this.orchestrator.bus.regressionPackageComplete({
          error: p.error,
          failed: 0,
          packageName: p.entry.packageName,
          passed: 0,
          success: false,
          total: 0,
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
        this.orchestrator.bus.regressionPackageComplete({
          failed: result.failed,
          packageName: p.entry.packageName,
          passed: result.passed,
          success: result.failed === 0,
          total: result.total,
        });
        return {
          installedPackage: p.entry.installedPackage,
          packageName: p.entry.packageName,
          result,
          success: result.failed === 0,
        } satisfies RegressionTestResult;
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        this.orchestrator.bus.regressionPackageComplete({
          error: msg,
          failed: 0,
          packageName: p.entry.packageName,
          passed: 0,
          success: false,
          total: 0,
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

    this.orchestrator.bus.regressionComplete({
      duration: Date.now() - regressionStart,
      failed,
      passed,
    });

    if (failed.length > 0) {
      logger?.warn(`Regression tests failed in ${failed.length} package(s): ${failed.join(', ')}`);
    } else {
      logger?.info(`Regression tests passed in all ${results.length} dependent package(s)`);
    }

    return results;
  }
}
