import type {Connection} from '@salesforce/core';

import {PackageVersion} from '@salesforce/packaging';

import type {Logger} from '../../types/logger.js';

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
 * Polls Salesforce for unlocked package async validation completion.
 *
 * Uses `PackageVersion.getCreateStatus()` to query the
 * Package2VersionCreateRequest by its ID. Returns once validation
 * completes, errors, or times out.
 *
 * Packages are polled sequentially to avoid flooding the DevHub
 * with concurrent queries.
 *
 * @example
 * ```typescript
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
   * Poll a single package's creation request for validation completion.
   */
  async pollOne(target: ValidationTarget): Promise<PackageValidationResult> {
    const {packageName, packageVersionCreateRequestId, packageVersionId} = target;

    if (!packageVersionCreateRequestId) {
      this.logger?.warn(`${packageName}: No creation request ID — skipping validation poll`);
      return {error: 'No package version creation request ID', packageName, status: 'Error'};
    }

    this.logger?.info(`${packageName}: Polling creation request ${packageVersionCreateRequestId}`);

    const deadline = Date.now() + this.maxWaitMs;

    /* eslint-disable no-await-in-loop -- polling loop is inherently sequential */
    while (Date.now() < deadline) {
      try {
        const result = await PackageVersion.getCreateStatus(packageVersionCreateRequestId, this.connection);

        if (!result) {
          this.logger?.warn(`${packageName}: Creation request ${packageVersionCreateRequestId} not found`);
          return {
            error: 'Creation request not found', packageName, packageVersionId, status: 'Error',
          };
        }

        this.logger?.debug(`${packageName}: Status = ${result.Status}`);

        if (result.Status === 'Success') {
          const coverage = result.CodeCoverage ?? undefined;
          this.logger?.info(`${packageName}: Validation passed (coverage: ${coverage ?? 'N/A'}%)`);
          return {
            codeCoverage: typeof coverage === 'number' ? coverage : undefined,
            hasPassedCodeCoverageCheck: result.HasPassedCodeCoverageCheck ?? undefined,
            packageName,
            packageVersionId: result.SubscriberPackageVersionId ?? packageVersionId,
            status: 'Success',
          };
        }

        if (result.Status === 'Error') {
          const errors = result.Error?.length
            // Error is typed as any[] by @salesforce/packaging
            ? result.Error.map((e: unknown) => (typeof e === 'string' ? e : (e as {Message?: string}).Message ?? JSON.stringify(e))).join('; ')
            : 'Unknown error';
          this.logger?.error(`${packageName}: Validation failed — ${errors}`);
          return {
            error: errors,
            packageName,
            packageVersionId: result.SubscriberPackageVersionId ?? packageVersionId,
            status: 'Error',
          };
        }

        // Status is Queued, InProgress, or Verifying — keep polling
        const remaining = Math.round((deadline - Date.now()) / 1000 / 60);
        this.logger?.debug(`${packageName}: ${result.Status}, ${remaining}m remaining`);
      } catch (error) {
        this.logger?.warn(`${packageName}: Error polling status — ${error instanceof Error ? error.message : String(error)}`);
      }

      await sleep(this.pollingIntervalMs);
    }
    /* eslint-enable no-await-in-loop */

    this.logger?.error(`${packageName}: Validation timed out after ${this.maxWaitMs / 1000 / 60}m`);
    return {
      error: `Validation timed out after ${this.maxWaitMs / 1000 / 60} minutes`,
      packageName,
      packageVersionId,
      status: 'TimedOut',
    };
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => {
    setTimeout(resolve, ms);
  });
}
