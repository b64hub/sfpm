import type {Connection} from '@salesforce/core';

import {Org} from '@salesforce/core';
import fs from 'node:fs';

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

import {type InstallOrchestrationResult, InstallOrchestrator} from '../../orchestrator/install-orchestrator.js';
import {ProjectGraph} from '../../project/project-graph.js';
import {type PackageValidationResult, ValidationPoller} from './validation-poller.js';

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

const PENDING_VALIDATIONS_FILE = 'pending-validations.json';

// ============================================================================
// ValidationCache
// ============================================================================

class ValidationCache {
  data: Map<string, PendingValidationDescriptor> = new Map();
  projectRoot: string;

  constructor(projectRoot: string) {
    this.projectRoot = projectRoot;
  }

  public add(descriptor: PendingValidationDescriptor): void {
    this.data.set(descriptor.packageName, descriptor);
  }

  public async read(): Promise<Map<string, PendingValidationDescriptor>> {
    const data = await fs.promises.readFile(`${this.projectRoot}/.sfpm/${PENDING_VALIDATIONS_FILE}`, 'utf8');
    const parsed = JSON.parse(data) as Record<string, PendingValidationDescriptor>;
    this.data = new Map(Object.entries(parsed));
    return this.data;
  }

  public remove(packageName: string): void {
    this.data.delete(packageName);
  }

  public async write(): Promise<void> {
    const data = JSON.stringify(Object.fromEntries(this.data), null, 2);
    await fs.promises.writeFile(`${this.projectRoot}/.sfpm/${PENDING_VALIDATIONS_FILE}`, data, 'utf8');
  }
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
 *   creation status via {@link ValidationPoller}.
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
    }

    return results;
  }

  // ========================================================================
  // Deploy validation (install orchestration)
  // ========================================================================

  private mapPollResult(result: PackageValidationResult): ValidationStateFailed | ValidationStatePassed {
    const checks: ValidationCheck[] = ['dependencies', 'deploy', 'test'];

    if (result.status === 'Success') {
      this.logger?.info(`Validation passed for '${result.packageName}' (coverage: ${result.codeCoverage ?? 'N/A'}%)`);
      this.sinkFor(result.packageName)?.passed({checks, codeCoverage: result.codeCoverage});
      return {
        checks,
        status: 'passed',
        testCoverage: result.codeCoverage,
      };
    }

    const error = result.error ?? `Validation ${result.status.toLowerCase()}`;
    this.logger?.debug(`Validation failed for '${result.packageName}': ${error}`);
    this.sinkFor(result.packageName)?.failed({error});
    return {
      checks,
      error,
      status: 'failed',
      testCoverage: result.codeCoverage,
    };
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

      const poller = new ValidationPoller(
        org.getConnection() as Connection,
        {maxWaitMs: options.maxWaitMs, pollingIntervalMs: options.pollingIntervalMs},
        this.logger,
      );

      const targets = group.map(d => ({
        packageName: d.packageName,
        packageVersionCreateRequestId: d.packageVersionRequestId,
      }));

      const pollResults = await poller.pollAll(targets);

      for (const pollResult of pollResults) {
        results.set(pollResult.packageName, this.mapPollResult(pollResult));
      }
    }));

    return results;
  }

  private sinkFor(packageName: string): ScopedValidationSink | undefined {
    return this.bus?.forPackage(packageName);
  }
}
