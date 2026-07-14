import type {Connection} from '@salesforce/core';

import type Logger from '../../types/logger.js';

import {PackageService} from '../package-service.js';

// ============================================================================
// Types
// ============================================================================

export interface ValidationPollingOptions {
  /** Maximum time to poll in milliseconds (default: 7_200_000 = 120 min) */
  maxWaitMs?: number;
  /** Polling interval in milliseconds (default: 30_000 = 30s) */
  pollingIntervalMs?: number;
}

export interface ValidationTarget {
  /** Package name */
  packageName: string;
  /** Package2VersionCreateRequest ID — used to poll async validation status */
  packageVersionCreateRequestId: string;
  /** Subscriber package version ID (04t...) — optional, for enriching results */
  packageVersionId?: string;
}

export interface PackageValidationResult {
  /** Code coverage percentage (if available) */
  codeCoverage?: number;
  /** Error message if validation failed */
  error?: string;
  /** Whether code coverage check passed */
  hasPassedCodeCoverageCheck?: boolean;
  /** Package name */
  packageName: string;
  /** Subscriber package version ID (04t...) */
  packageVersionId?: string;
  /** Final validation status */
  status: 'Error' | 'Skipped' | 'Success' | 'TimedOut';
}

// ============================================================================
// Constants
// ============================================================================

const DEFAULT_POLLING_INTERVAL_MS = 30_000;
const DEFAULT_MAX_WAIT_MS = 7_200_000; // 120 minutes

// ============================================================================
// ValidationPoller
// ============================================================================

/**
 * @deprecated Use {@link PackageService.awaitPackageValidation} (or the static
 * {@link PackageService.awaitValidation}) directly.  This class will be removed
 * in a future major version.
 *
 * Polls Salesforce for unlocked package async validation completion.
 *
 * @example
 * ```typescript
 * // Preferred
 * await packageService.awaitPackageValidation(requestId, options);
 *
 * // Legacy
 * const poller = new ValidationPoller(connection, logger);
 * const results = await poller.pollAll([
 *   { packageName: 'my-pkg', packageVersionCreateRequestId: '08c...' },
 * ]);
 * ```
 */
export class ValidationPoller {
  private readonly connection: Connection;
  private readonly logger?: Logger;
  private readonly maxWaitMs: number;
  private readonly pollingIntervalMs: number;

  constructor(
    connection: Connection,
    options?: ValidationPollingOptions,
    logger?: Logger,
  ) {
    this.connection = connection;
    this.maxWaitMs = options?.maxWaitMs ?? DEFAULT_MAX_WAIT_MS;
    this.pollingIntervalMs = options?.pollingIntervalMs ?? DEFAULT_POLLING_INTERVAL_MS;
    this.logger = logger;
  }

  /**
   * Poll all targets sequentially.
   *
   * Intentionally sequential — each package's validation is independent but
   * we poll one at a time to avoid flooding the DevHub with concurrent queries.
   */
  async pollAll(targets: ValidationTarget[]): Promise<PackageValidationResult[]> {
    const results: PackageValidationResult[] = [];

    for (const target of targets) {
      // eslint-disable-next-line no-await-in-loop -- sequential polling is intentional
      const result = await this.pollOne(target);
      results.push(result);
    }

    return results;
  }

  /**
   * @deprecated Use {@link PackageService.awaitPackageValidation} instead.
   */
  async pollOne(target: ValidationTarget): Promise<PackageValidationResult> {
    const {packageName, packageVersionCreateRequestId, packageVersionId} = target;

    if (!packageVersionCreateRequestId) {
      this.logger?.warn(`${packageName}: No creation request ID — skipping validation poll`);
      return {error: 'No package version creation request ID', packageName, status: 'Error'};
    }

    this.logger?.info(`${packageName}: Polling creation request ${packageVersionCreateRequestId}`);

    try {
      const result = await PackageService.awaitValidation(
        packageVersionCreateRequestId,
        this.connection,
        {maxWaitMs: this.maxWaitMs, pollingIntervalMs: this.pollingIntervalMs},
        this.logger,
      );

      if (result.Status === 'Success') {
        this.logger?.info(`${packageName}: Validation passed (coverage: ${result.CodeCoverage ?? 'N/A'}%)`);
        return {
          codeCoverage: typeof result.CodeCoverage === 'number' ? result.CodeCoverage : undefined,
          hasPassedCodeCoverageCheck: result.HasPassedCodeCoverageCheck ?? undefined,
          packageName,
          packageVersionId: result.SubscriberPackageVersionId ?? packageVersionId,
          status: 'Success',
        };
      }

      // Status === 'Error'
      // Error is typed as any[] by @salesforce/packaging
      const errors = result.Error?.length
        ? result.Error.map((e: unknown) => (typeof e === 'string' ? e : (e as {Message?: string}).Message ?? JSON.stringify(e))).join('; ')
        : 'Unknown error';
      this.logger?.error(`${packageName}: Validation failed — ${errors}`);
      return {
        error: errors,
        packageName,
        packageVersionId: result.SubscriberPackageVersionId ?? packageVersionId,
        status: 'Error',
      };
    } catch (error) {
      if ((error as {name?: string}).name === 'PackageValidationTimeout') {
        const {message} = (error as Error);
        this.logger?.error(`${packageName}: ${message}`);
        return {
          error: message, packageName, packageVersionId, status: 'TimedOut',
        };
      }

      const message = error instanceof Error ? error.message : String(error);
      this.logger?.warn(`${packageName}: Unexpected error — ${message}`);
      return {
        error: message, packageName, packageVersionId, status: 'Error',
      };
    }
  }
}
