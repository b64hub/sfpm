import type {Connection} from '@salesforce/core';

import {Org} from '@salesforce/core';

import type {ScopedValidationSink, ValidationEventBus, ValidationEventSink} from '../../events/index.js';
import type {ProjectDefinitionProvider} from '../../project/providers/project-definition-provider.js';
import type Logger from '../../types/logger.js';
import type {TestLevel} from '../../types/package.js';
import type {
  DeployValidationDescriptor,
  PackageVersionValidationDescriptor,
  PendingValidationDescriptor,
  ValidationCheck,
  ValidationStateFailed,
  ValidationStatePassed,
} from '../../types/validation.js';

import {ArtifactRepository} from '../../artifacts/artifact-repository.js';
import {type InstallOrchestrationResult, InstallOrchestrator} from '../../orchestrator/install-orchestrator.js';
import {ProjectGraph} from '../../project/project-graph.js';
import PackageService, {type PackageVersionCreateRequestResult} from '../package-service.js';

// ============================================================================
// Types
// ============================================================================

export interface ResolveOptions {
  /** Minimum code coverage percentage required (default: 75) */
  coverageThreshold?: number;
  /** Maximum time to wait for package version polling in milliseconds (default: 7_200_000 = 120 min) */
  maxWaitMs?: number;
  /** Polling interval for package version requests in milliseconds (default: 30_000 = 30s) */
  pollingIntervalMs?: number;
  /** Run regression tests on direct dependents after deploy validation */
  regressionTest?: boolean;
}

// ============================================================================
// ValidationResolver
// ============================================================================

/**
 * Resolves pending validation operations into a final {@link ValidationState}.
 *
 * Routes by `operationType`:
 * - `'deploy'` — runs an install orchestration for all deploy packages
 *   (with optional regression testing of direct dependents), then maps
 *   per-package install results to validation states.
 * - `'package-version-request'` — polls the DevHub for unlocked package
 *   creation status via {@link PackageService.awaitValidation}.
 *
 * Both paths run in parallel. Org connections are resolved internally
 * from descriptor fields, so the API stays simple: pass descriptors in,
 * get validation states out.
 *
 * @example
 * ```ts
 * const resolver = new ValidationResolver(provider, graph, logger, bus);
 * const results = await resolver.resolve(descriptors, { regressionTest: true });
 * ```
 */
export class ValidationResolver {
  private readonly bus?: ValidationEventBus;
  private readonly graph: ProjectGraph;
  private readonly logger?: Logger;
  private readonly options?: ResolveOptions;
  private readonly provider: ProjectDefinitionProvider;
  private readonly sink?: ValidationEventSink;

  constructor(
    provider: ProjectDefinitionProvider,
    graph: ProjectGraph,
    logger?: Logger,
    bus?: ValidationEventBus,
    options?: ResolveOptions,
  ) {
    this.provider = provider;
    this.graph = graph;
    this.logger = logger;
    this.bus = bus;
    this.options = options;
  }

  /**
   * Resolve pending validations.
   *
   * - Deploy descriptors are validated via a single install orchestration.
   * - Package-version-request descriptors are polled in parallel.
   * - Both paths run concurrently.
   */
  async resolve(
    descriptors: PendingValidationDescriptor[],
    options?: ResolveOptions,
  ): Promise<Map<string, ValidationStateFailed | ValidationStatePassed>> {
    const mergedOptions = {...this.options, ...options};
    const packageNames = descriptors.map(d => d.packageName);

    this.sink?.start({packageNames});
    this.logger?.info(`Resolving ${descriptors.length} validation(s): ${packageNames.join(', ')}`);

    const deployDescriptors = descriptors.filter((d): d is DeployValidationDescriptor => d.operationType === 'deploy');
    const packageVersionDescriptors = descriptors.filter((d): d is PackageVersionValidationDescriptor => d.operationType === 'package-version-request');

    const results = new Map<string, ValidationStateFailed | ValidationStatePassed>();

    try {
      await Promise.all([
        this.resolveDeployValidation(deployDescriptors, mergedOptions).then(resolved => {
          for (const [name, result] of resolved) {
            results.set(name, result);
          }
        }),
        this.resolvePackageVersionRequests(packageVersionDescriptors, mergedOptions).then(resolved => {
          for (const [name, result] of resolved) {
            results.set(name, result);
          }
        }),
      ]);
    } finally {
      const passed = [...results.values()].filter(r => r.status === 'passed').length;
      const failed = [...results.values()].filter(r => r.status === 'failed').length;

      this.sink?.complete({
        failed, passed, timedOut: 0, total: results.size,
      });

      await this.persistResults(results);
    }

    return results;
  }

  // ========================================================================
  // Artifact persistence
  // ========================================================================

  private mapReport(
    descriptor: PackageVersionValidationDescriptor,
    report: PackageVersionCreateRequestResult,
  ): ValidationStateFailed | ValidationStatePassed {
    const checks: ValidationCheck[] = ['dependencies', 'deploy', 'test'];

    if (report.Status === 'Success') {
      const codeCoverage = typeof report.CodeCoverage === 'number' ? report.CodeCoverage : undefined;
      this.logger?.info(`Validation passed for '${descriptor.packageName}' (coverage: ${codeCoverage ?? 'N/A'}%)`);
      this.sinkFor(descriptor.packageName)?.passed({checks, codeCoverage});
      return {checks, status: 'passed', testCoverage: codeCoverage};
    }

    // Status === 'Error'
    const errors = (report.Error as undefined | unknown[])?.length
      ? (report.Error as unknown[]).map(e => typeof e === 'string' ? e : (e as {Message?: string}).Message ?? JSON.stringify(e)).join('; ')
      : 'Unknown error';
    this.logger?.error(`Validation failed for '${descriptor.packageName}': ${errors}`);
    this.sinkFor(descriptor.packageName)?.failed({error: errors});
    return {checks, error: errors, status: 'failed'};
  }

  // ========================================================================
  // Deploy validation (install orchestration)
  // ========================================================================

  /**
   * Write validation results to each package's `dist/package.json`.
   * Uses the provider to resolve package paths and ArtifactRepository
   * to patch the `sfpm.validation` field.
   */
  private async persistResults(results: Map<string, ValidationStateFailed | ValidationStatePassed>): Promise<void> {
    for (const [packageName, result] of results) {
      const definition = this.provider.getPackageDefinition(packageName);
      if (!definition?.path) continue;

      try {
        const repo = new ArtifactRepository(definition.path, this.logger, packageName);
        // eslint-disable-next-line no-await-in-loop
        await repo.updateValidation(result as unknown as Record<string, unknown>);
        this.logger?.debug(`Persisted validation result for '${packageName}'`);
      } catch (error) {
        this.logger?.warn(`Failed to persist validation for '${packageName}': ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  // ========================================================================
  // Package version request validation (polling)
  // ========================================================================

  private async resolveDeployValidation(
    descriptors: DeployValidationDescriptor[],
    options: ResolveOptions,
  ): Promise<Map<string, ValidationStateFailed | ValidationStatePassed>> {
    const results = new Map<string, ValidationStateFailed | ValidationStatePassed>();
    if (descriptors.length === 0) return results;

    const targetOrgAlias = descriptors[0].targetOrg;
    const {testLevel} = descriptors[0];
    const packageNames = descriptors.map(d => d.packageName);

    this.logger?.info(`Deploy validation: installing ${packageNames.length} package(s) to ${targetOrgAlias}`);

    let targetOrg: Org;
    try {
      targetOrg = await Org.create({aliasOrUsername: targetOrgAlias});
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      for (const name of packageNames) {
        results.set(name, {
          checks: ['deploy'],
          error: `Failed to connect to org ${targetOrgAlias}: ${message}`,
          status: 'failed',
        });
      }

      return results;
    }

    const orchestrator = InstallOrchestrator.forArtifact(
      targetOrg,
      this.provider,
      this.graph,
      {
        includeDependencies: true,
        regressionTest: options.regressionTest,
        testLevel: testLevel as TestLevel | undefined,
      },
      this.logger,
    );

    let orchestrationResult: InstallOrchestrationResult;
    try {
      orchestrationResult = await orchestrator.installAll(packageNames);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      for (const name of packageNames) {
        results.set(name, {
          checks: ['deploy'],
          error: `Install orchestration failed: ${message}`,
          status: 'failed',
        });
      }

      return results;
    }

    // Map per-package install results to validation states
    for (const pkgResult of orchestrationResult.results) {
      if (pkgResult.success) {
        results.set(pkgResult.packageName, {
          checks: ['deploy'],
          status: 'passed',
        });
      } else {
        results.set(pkgResult.packageName, {
          checks: ['deploy'],
          error: pkgResult.error ?? 'Installation failed',
          status: 'failed',
        });
      }
    }

    return results;
  }

  // ========================================================================
  // Helpers
  // ========================================================================

  private async resolvePackageVersionRequests(
    descriptors: PackageVersionValidationDescriptor[],
    options: ResolveOptions,
  ): Promise<Map<string, ValidationStateFailed | ValidationStatePassed>> {
    const results = new Map<string, ValidationStateFailed | ValidationStatePassed>();
    if (descriptors.length === 0) return results;

    // Group by devhub to share connections
    const byDevhub = new Map<string, PackageVersionValidationDescriptor[]>();
    for (const d of descriptors) {
      const group = byDevhub.get(d.devhub) ?? [];
      group.push(d);
      byDevhub.set(d.devhub, group);
    }

    await Promise.all([...byDevhub.entries()].map(async ([devhub, group]) => {
      let org: Org;
      try {
        org = await Org.create({aliasOrUsername: devhub});
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        for (const d of group) {
          results.set(d.packageName, {
            checks: ['dependencies', 'deploy', 'test'],
            error: `Failed to connect to devhub ${devhub}: ${message}`,
            status: 'failed',
          });
        }

        return;
      }

      await Promise.all(group.map(async descriptor => {
        try {
          const report = await PackageService.awaitValidation(
            descriptor.packageVersionRequestId,
            org.getConnection() as Connection,
            {maxWaitMs: options.maxWaitMs, pollingIntervalMs: options.pollingIntervalMs},
            this.logger,
          );
          results.set(descriptor.packageName, this.mapReport(descriptor, report));
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          const timedOut = (error as {name?: string}).name === 'PackageValidationTimeout';
          this.logger?.[timedOut ? 'error' : 'warn'](`${descriptor.packageName}: ${message}`);
          this.sinkFor(descriptor.packageName)?.failed({error: message});
          results.set(descriptor.packageName, {
            checks: ['dependencies', 'deploy', 'test'],
            error: message,
            status: 'failed',
          });
        }
      }));
    }));

    return results;
  }

  private sinkFor(packageName: string): ScopedValidationSink | undefined {
    return this.bus?.forPackage(packageName);
  }
}
