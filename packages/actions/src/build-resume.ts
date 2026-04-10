import * as core from '@actions/core';
import * as github from '@actions/github';
import {
  isStructuredLogger,
  type Logger,
} from '@b64/sfpm-core';
import {type Connection, Org} from '@salesforce/core';
import {PackageVersion} from '@salesforce/packaging';

import {BuildCacheService, type PackageBuildState} from './build-cache.js';
import {createGitHubActionsLogger} from './logger.js';

// ============================================================================
// Types
// ============================================================================

export interface BuildResumeOptions {
  /** DevHub username or alias (overrides cached value) */
  devhubUsername?: string;
  /** Maximum time to poll for validation in minutes (default: 120) */
  maxWaitMinutes?: number;
  /** Polling interval in seconds (default: 30) */
  pollingIntervalSeconds?: number;
  /** Project directory (default: workspace root) */
  projectDir?: string;
  /** GitHub Actions run ID to restore build state from (default: current run) */
  runId?: string;
}

export interface BuildResumeResult {
  /** Duration of the resume step in milliseconds */
  duration: number;
  /** Per-package validation outcomes */
  packages: PackageValidationResult[];
  /** Whether all validations passed */
  success: boolean;
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
// Build Resume Pipeline
// ============================================================================

/**
 * Resume a build workflow by polling for unlocked package async validation.
 *
 * Workflow:
 * 1. Restore cached build state from the `build` job
 * 2. Connect to DevHub
 * 3. For each unlocked package pending validation, poll the
 *    Package2VersionCreateRequest status using the creation request ID
 *    until validation completes, errors, or times out
 * 4. Report results via GitHub Actions outputs
 *
 * This action is designed to run in a separate job AFTER the deploy step,
 * giving Salesforce time to complete async validation while the deploy
 * runs in parallel.
 *
 * @example
 * ```typescript
 * const result = await buildResume({
 *   devhubUsername: 'devhub@myorg.com',
 *   maxWaitMinutes: 120,
 * });
 * ```
 */
export async function buildResume(options: BuildResumeOptions): Promise<BuildResumeResult> {
  const logger = createGitHubActionsLogger({prefix: 'build-resume'});
  const startTime = Date.now();

  // ------------------------------------------------------------------
  // 1. Restore cached build state
  // ------------------------------------------------------------------
  const runId = options.runId ?? String(github.context.runId);
  const buildCache = new BuildCacheService({logger, runId});

  const state = await buildCache.restore();
  if (!state) {
    core.setFailed(`No build state found for run ${runId}. Did the build job complete?`);
    return {duration: 0, packages: [], success: false};
  }

  const pendingPackages = state.packages.filter(p => p.needsValidation);
  if (pendingPackages.length === 0) {
    logger.info('No packages pending validation — nothing to resume');
    const result: BuildResumeResult = {duration: Date.now() - startTime, packages: [], success: true};
    setActionOutputs(result);
    return result;
  }

  logger.info(`Resuming validation for ${pendingPackages.length} unlocked package(s)`);

  // ------------------------------------------------------------------
  // 2. Connect to DevHub
  // ------------------------------------------------------------------
  const devhubUsername = options.devhubUsername ?? state.devhubUsername;
  if (!devhubUsername) {
    core.setFailed('DevHub username required for validation polling');
    return {duration: 0, packages: [], success: false};
  }

  logger.info(`Connecting to DevHub: ${devhubUsername}`);
  const devhub = await Org.create({aliasOrUsername: devhubUsername});
  const connection = devhub.getConnection();

  // ------------------------------------------------------------------
  // 3. Poll validation status for each pending package
  // ------------------------------------------------------------------
  if (isStructuredLogger(logger)) logger.group('Validation Polling');

  const maxWaitMs = (options.maxWaitMinutes ?? 120) * 60 * 1000;
  const pollingIntervalMs = (options.pollingIntervalSeconds ?? 30) * 1000;

  const validationResults: PackageValidationResult[] = await pollAllPackages(
    pendingPackages,
    connection,
    {maxWaitMs, pollingIntervalMs},
    logger,
  );

  // Include non-validation packages as skipped
  for (const pkg of state.packages.filter(p => !p.needsValidation)) {
    validationResults.push({
      packageName: pkg.packageName,
      packageVersionId: pkg.packageVersionId,
      status: 'Skipped',
    });
  }

  if (isStructuredLogger(logger)) logger.groupEnd();

  // ------------------------------------------------------------------
  // 4. Set outputs and return
  // ------------------------------------------------------------------
  const duration = Date.now() - startTime;
  const allPassed = validationResults
  .filter(r => r.status !== 'Skipped')
  .every(r => r.status === 'Success');

  const result: BuildResumeResult = {
    duration,
    packages: validationResults,
    success: allPassed,
  };

  setActionOutputs(result);

  if (allPassed) {
    logger.info(`All validations passed in ${Math.round(duration / 1000)}s`);
  } else {
    const failed = validationResults.filter(r => r.status === 'Error' || r.status === 'TimedOut');
    core.setFailed(`Validation failed for: ${failed.map(f => f.packageName).join(', ')}`);
  }

  return result;
}

// ============================================================================
// Validation Polling
// ============================================================================

interface PollingOptions {
  maxWaitMs: number;
  pollingIntervalMs: number;
}

/**
 * Poll a single unlocked package's creation request for validation completion.
 *
 * Uses `PackageVersion.getCreateStatus()` to query the
 * Package2VersionCreateRequest by its ID. This returns the current
 * status of the async validation (Queued, InProgress, Success, Error).
 *
 * Returns once validation completes, errors, or times out.
 */
/**
 * Poll all pending packages sequentially.
 *
 * Intentionally sequential — each package's validation is independent but
 * we poll one at a time to avoid flooding the DevHub with concurrent queries.
 */
async function pollAllPackages(
  packages: PackageBuildState[],
  connection: Connection,
  pollingOptions: PollingOptions,
  logger: Logger,
): Promise<PackageValidationResult[]> {
  const results: PackageValidationResult[] = [];

  for (const pkg of packages) {
    // eslint-disable-next-line no-await-in-loop -- sequential polling is intentional
    const result = await pollPackageValidation(pkg, connection, pollingOptions, logger);
    results.push(result);
  }

  return results;
}

async function pollPackageValidation(
  pkg: PackageBuildState,
  connection: Connection,
  pollingOptions: PollingOptions,
  logger: Logger,
): Promise<PackageValidationResult> {
  const {packageName, packageVersionCreateRequestId} = pkg;

  if (!packageVersionCreateRequestId) {
    logger.warn(`${packageName}: No creation request ID — skipping validation poll`);
    return {error: 'No package version creation request ID', packageName, status: 'Error'};
  }

  logger.info(`${packageName}: Polling creation request ${packageVersionCreateRequestId}`);

  const deadline = Date.now() + pollingOptions.maxWaitMs;

  /* eslint-disable no-await-in-loop -- polling loop is inherently sequential */
  while (Date.now() < deadline) {
    try {
      const result = await PackageVersion.getCreateStatus(packageVersionCreateRequestId, connection);

      if (!result) {
        logger.warn(`${packageName}: Creation request ${packageVersionCreateRequestId} not found`);
        return {
          error: 'Creation request not found', packageName, packageVersionId: pkg.packageVersionId, status: 'Error',
        };
      }

      logger.debug(`${packageName}: Status = ${result.Status}`);

      if (result.Status === 'Success') {
        const coverage = result.CodeCoverage ?? undefined;
        logger.info(`${packageName}: Validation passed (coverage: ${coverage ?? 'N/A'}%)`);
        return {
          codeCoverage: typeof coverage === 'number' ? coverage : undefined,
          hasPassedCodeCoverageCheck: result.HasPassedCodeCoverageCheck ?? undefined,
          packageName,
          packageVersionId: result.SubscriberPackageVersionId ?? pkg.packageVersionId,
          status: 'Success',
        };
      }

      if (result.Status === 'Error') {
        const errors = result.Error?.length
          // Error is typed as any[] by @salesforce/packaging
          ? result.Error.map((e: unknown) => (typeof e === 'string' ? e : (e as {Message?: string}).Message ?? JSON.stringify(e))).join('; ')
          : 'Unknown error';
        logger.error(`${packageName}: Validation failed — ${errors}`);
        return {
          error: errors,
          packageName,
          packageVersionId: result.SubscriberPackageVersionId ?? pkg.packageVersionId,
          status: 'Error',
        };
      }

      // Status is Queued, InProgress, or Verifying — keep polling
      const remaining = Math.round((deadline - Date.now()) / 1000 / 60);
      logger.debug(`${packageName}: ${result.Status}, ${remaining}m remaining`);
    } catch (error) {
      logger.warn(`${packageName}: Error polling status — ${error instanceof Error ? error.message : String(error)}`);
    }

    await sleep(pollingOptions.pollingIntervalMs);
  }
  /* eslint-enable no-await-in-loop */

  logger.error(`${packageName}: Validation timed out after ${pollingOptions.maxWaitMs / 1000 / 60}m`);
  return {
    error: `Validation timed out after ${pollingOptions.maxWaitMs / 1000 / 60} minutes`,
    packageName,
    packageVersionId: pkg.packageVersionId,
    status: 'TimedOut',
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => {
    setTimeout(resolve, ms);
  });
}

// ============================================================================
// Helpers
// ============================================================================

function setActionOutputs(result: BuildResumeResult): void {
  core.setOutput('success', String(result.success));
  core.setOutput('duration', String(result.duration));
  core.setOutput('result', JSON.stringify(result));

  const validated = result.packages.filter(p => p.status === 'Success');
  const failed = result.packages.filter(p => p.status === 'Error' || p.status === 'TimedOut');

  core.setOutput('validated-count', String(validated.length));
  core.setOutput('failed-count', String(failed.length));
  core.setOutput('failed-packages', failed.map(f => f.packageName).join(','));
}
