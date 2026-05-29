import type {Connection} from '@salesforce/core';

import {Org} from '@salesforce/core';

import type {Logger} from '../../types/logger.js';
import type {
  PendingValidationDescriptor,
  ValidationStateFailed,
  ValidationStatePassed,
} from '../../types/package.js';

import {type DeployResult, MetadataDeployService} from '../../tooling/metadata-deploy-service.js';
import {type PackageValidationResult, ValidationPoller} from './validation-poller.js';

// ============================================================================
// Types
// ============================================================================

/** Default coverage threshold when resolving deploy-based validations. */
const DEFAULT_COVERAGE_THRESHOLD = 75;

export interface ResolveOptions {
  /** Minimum code coverage percentage required (default: 75) */
  coverageThreshold?: number;
  /** An existing MetadataDeployService instance that holds the pending deploy in its registry. */
  deployService?: MetadataDeployService;
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
 * @example
 * ```ts
 * const resolver = new ValidationResolver(logger);
 * const finalState = await resolver.resolve(pendingDescriptor, {
 *   deployService, // same instance that started the deploy
 * });
 * ```
 */
export class ValidationResolver {
  private readonly logger?: Logger;

  constructor(logger?: Logger) {
    this.logger = logger;
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
   * Resolve multiple pending validations in sequence.
   * Sequential to avoid flooding the DevHub/org with concurrent queries.
   */
  async resolveAll(
    descriptors: PendingValidationDescriptor[],
    options?: ResolveOptions,
  ): Promise<Map<string, ValidationStateFailed | ValidationStatePassed>> {
    const results = new Map<string, ValidationStateFailed | ValidationStatePassed>();

    for (const descriptor of descriptors) {
      // eslint-disable-next-line no-await-in-loop -- sequential resolution is intentional
      const result = await this.resolve(descriptor, options);
      results.set(descriptor.packageName, result);
    }

    return results;
  }

  private evaluateDeployResult(
    result: DeployResult,
    packageName: string,
    coverageThreshold: number,
  ): ValidationStateFailed | ValidationStatePassed {
    // Check deployment success
    if (!result.success) {
      return {
        checks: ['deploy'],
        error: result.formatErrors() || 'Unknown deployment error',
        status: 'failed',
      };
    }

    // Check test failures
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

    // Check coverage threshold
    if (!result.meetsCoverageThreshold(coverageThreshold)) {
      return {
        checks: ['deploy', 'test'],
        error: `Coverage ${result.testResults!.coverage}% is below required ${coverageThreshold}%`,
        status: 'failed',
        testCoverage: result.testResults!.coverage,
      };
    }

    // All passed
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
    const deployService = options?.deployService;
    if (!deployService) {
      return {
        checks: ['deploy', 'test'],
        error: `Cannot resolve deploy '${descriptor.operationId}' — no deployService provided. `
          + 'Pass the same MetadataDeployService instance that initiated the deploy.',
        status: 'failed',
      };
    }

    const threshold = options?.coverageThreshold ?? DEFAULT_COVERAGE_THRESHOLD;

    this.logger?.info(`Awaiting deploy '${descriptor.operationId}' for '${descriptor.packageName}'`);
    const result = await deployService.awaitDeploy(descriptor.operationId, descriptor.targetOrg);

    return this.evaluateDeployResult(result, descriptor.packageName, threshold);
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
}
