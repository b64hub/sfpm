import type {Connection} from '@salesforce/core';

import {Org} from '@salesforce/core';

import type {ScopedValidationSink, ValidationEventBus, ValidationEventSink} from '../../events/validation-event-bus.js';
import type {Logger} from '../../types/logger.js';
import type {
  PendingValidationDescriptor,
  ValidationStateFailed,
  ValidationStatePassed,
} from '../../types/package.js';

import {type DeployResult, MetadataDeployService} from '../../tooling/metadata-deploy-service.js';
import {type PackageValidationResult, ValidationPoller} from './validation-poller.js';

/** Terminal validation result tagged with the originating package name. */
interface PackageValidationOutcome {
  packageName: string;
  result: ValidationStateFailed | ValidationStatePassed;
}

// ============================================================================
// Types
// ============================================================================

/** Default coverage threshold when resolving deploy-based validations. */
const DEFAULT_COVERAGE_THRESHOLD = 75;

export interface ResolveOptions {
  /** Minimum code coverage percentage required (default: 75) */
  coverageThreshold?: number;
  /** Maximum time to wait for resolution in milliseconds (default: 7_200_000 = 120 min) */
  maxWaitMs?: number;
  /** Polling interval in milliseconds (default: 30_000 = 30s) */
  pollingIntervalMs?: number;
}

// ============================================================================
// ValidationResolver
// ============================================================================

/**
 * Resolves pending validation operations into a final {@link ValidationState}.
 *
 * Routes by `operationType`:
 * - `'package-version-request'` — polls the DevHub for unlocked package creation status
 * - `'deploy'` — awaits a metadata deployment for completion, checks test results + coverage
 *
 * This service composes {@link ValidationPoller} (for unlocked packages) and
 * {@link MetadataDeployService} (for source packages) to provide a unified
 * resolution contract.
 *
 * Accepts an optional {@link ValidationEventSink} for progress reporting.
 * When provided, the resolver emits lifecycle events that renderers can
 * subscribe to for real-time UI feedback.
 *
 * @example
 * ```ts
 * const bus = new ValidationEventBus();
 * const resolver = new ValidationResolver(logger, bus);
 * renderer.attachTo(bus);
 * const results = await resolver.resolveAll(descriptors);
 * ```
 */
export class ValidationResolver {
  private readonly bus?: ValidationEventBus;
  private readonly logger?: Logger;
  private readonly sink?: ValidationEventSink;

  constructor(logger?: Logger, bus?: ValidationEventBus) {
    this.logger = logger;
    this.bus = bus;
    this.sink = bus?.asSink();
  }

  /**
   * Resolve a pending validation into a terminal state (passed or failed).
   */
  async resolve(
    descriptor: PendingValidationDescriptor,
    options?: ResolveOptions,
  ): Promise<ValidationStateFailed | ValidationStatePassed> {
    this.logger?.info(`Resolving pending validation for '${descriptor.packageName}' (${descriptor.operationType})`);

    switch (descriptor.operationType) {
    case 'deploy': {
      return this.resolveDeploy(descriptor, options);
    }

    case 'package-version-request': {
      return this.resolvePackageVersion(descriptor, options);
    }

    default: {
      return {
        checks: [],
        error: `Unknown operation type: ${descriptor.operationType}`,
        status: 'failed',
      };
    }
    }
  }

  /**
   * Resolve multiple pending validations with optimal concurrency.
   *
   * - Deploy-type descriptors are resolved sequentially (they target the same org).
   * - Package-version-request descriptors are resolved in parallel (independent server-side).
   */
  async resolveAll(
    descriptors: PendingValidationDescriptor[],
    options?: ResolveOptions,
  ): Promise<Map<string, ValidationStateFailed | ValidationStatePassed>> {
    const packageNames = descriptors.map(d => d.packageName);
    this.sink?.start({packageNames});

    const deploys = descriptors.filter(d => d.operationType === 'deploy');
    const versionRequests = descriptors.filter(d => d.operationType === 'package-version-request');

    const deployOutcomes = await this.resolveDeploysSequentially(deploys, options);
    const versionOutcomes = await this.resolveVersionRequestsInParallel(versionRequests, options);

    const results = new Map<string, ValidationStateFailed | ValidationStatePassed>();
    for (const {packageName, result} of [...deployOutcomes, ...versionOutcomes]) {
      results.set(packageName, result);
    }

    const passed = [...results.values()].filter(r => r.status === 'passed').length;
    const failed = [...results.values()].filter(r => r.status === 'failed').length;
    this.sink?.complete({
      failed, passed, timedOut: 0, total: results.size,
    });

    return results;
  }

  /**
   * Emit the terminal result (passed or failed) through a scoped sink.
   */
  private emitOutcome(sink: ScopedValidationSink, result: ValidationStateFailed | ValidationStatePassed): void {
    if (result.status === 'passed') {
      sink.passed({checks: result.checks, codeCoverage: result.testCoverage});
    } else {
      sink.failed({codeCoverage: result.testCoverage, error: result.error ?? 'Unknown error'});
    }
  }

  private evaluateDeployResult(
    result: DeployResult,
    packageName: string,
    coverageThreshold: number,
  ): ValidationStateFailed | ValidationStatePassed {
    if (!result.success) {
      return {
        checks: ['deploy'],
        error: result.formatErrors() || 'Unknown deployment error',
        status: 'failed',
      };
    }

    if (result.hasTestFailures()) {
      const failureDetails = result.testResults!.failures
      .map(f => `${f.name}.${f.methodName}: ${f.message}`)
      .join('\n');

      return {
        checks: ['deploy', 'test'],
        error: `${result.testResults!.failed} Apex test(s) failed:\n${failureDetails}`,
        status: 'failed',
        testCoverage: result.testResults!.coverage,
      };
    }

    if (!result.meetsCoverageThreshold(coverageThreshold)) {
      return {
        checks: ['deploy', 'test'],
        error: `Coverage ${result.testResults!.coverage}% is below required ${coverageThreshold}%`,
        status: 'failed',
        testCoverage: result.testResults!.coverage,
      };
    }

    this.logger?.info(`Validation passed for '${packageName}' (coverage: ${result.testResults?.coverage ?? 'N/A'}%)`);
    return {
      checks: ['deploy', 'test'],
      status: 'passed',
      testCoverage: result.testResults?.coverage,
    };
  }

  private async resolveDeploy(
    descriptor: PendingValidationDescriptor,
    options?: ResolveOptions,
  ): Promise<ValidationStateFailed | ValidationStatePassed> {
    const threshold = options?.coverageThreshold ?? DEFAULT_COVERAGE_THRESHOLD;
    const deployService = new MetadataDeployService(this.logger);

    this.logger?.info(`Awaiting deploy '${descriptor.operationId}' for '${descriptor.packageName}'`);
    const result = await deployService.awaitDeploy(descriptor.operationId, descriptor.targetOrg);

    return this.evaluateDeployResult(result, descriptor.packageName, threshold);
  }

  /**
   * Resolve deploy-type descriptors sequentially (they target the same org).
   * Each descriptor gets its own scoped sink for per-package event emission.
   */
  private async resolveDeploysSequentially(
    descriptors: PendingValidationDescriptor[],
    options?: ResolveOptions,
  ): Promise<PackageValidationOutcome[]> {
    const outcomes: PackageValidationOutcome[] = [];

    for (const descriptor of descriptors) {
      const sink = this.sinkFor(descriptor.packageName);
      sink?.status({status: 'polling'});

      // eslint-disable-next-line no-await-in-loop -- sequential resolution is intentional
      const result = await this.resolve(descriptor, options);

      if (sink) this.emitOutcome(sink, result);
      outcomes.push({packageName: descriptor.packageName, result});
    }

    return outcomes;
  }

  private async resolvePackageVersion(
    descriptor: PendingValidationDescriptor,
    options?: ResolveOptions,
  ): Promise<ValidationStateFailed | ValidationStatePassed> {
    const org = await Org.create({aliasOrUsername: descriptor.targetOrg});
    const connection = org.getConnection();

    const poller = new ValidationPoller(connection as unknown as Connection, {
      maxWaitMs: options?.maxWaitMs,
      pollingIntervalMs: options?.pollingIntervalMs,
    }, this.logger);

    const result: PackageValidationResult = await poller.pollOne({
      packageName: descriptor.packageName,
      packageVersionCreateRequestId: descriptor.operationId,
    });

    if (result.status === 'Success') {
      return {
        checks: ['deploy', 'test', 'dependencies'],
        status: 'passed',
        testCoverage: result.codeCoverage,
      };
    }

    return {
      checks: ['deploy', 'test', 'dependencies'],
      error: result.error ?? `Validation ${result.status.toLowerCase()}`,
      status: 'failed',
      testCoverage: result.codeCoverage,
    };
  }

  /**
   * Resolve package-version-request descriptors in parallel (independent server-side).
   * Each descriptor gets its own scoped sink for per-package event emission.
   */
  private async resolveVersionRequestsInParallel(
    descriptors: PendingValidationDescriptor[],
    options?: ResolveOptions,
  ): Promise<PackageValidationOutcome[]> {
    if (descriptors.length === 0) return [];

    return Promise.all(descriptors.map(async descriptor => {
      const sink = this.sinkFor(descriptor.packageName);
      sink?.status({status: 'polling'});

      const result = await this.resolve(descriptor, options);

      if (sink) this.emitOutcome(sink, result);
      return {packageName: descriptor.packageName, result};
    }));
  }

  /**
   * Create a package-scoped validation sink, or `undefined` if no bus is wired.
   */
  private sinkFor(packageName: string): ScopedValidationSink | undefined {
    return this.bus?.forPackage(packageName);
  }
}
