import * as core from '@actions/core';
import * as github from '@actions/github';
import {
  type PackageValidationResult,
  ValidationPoller,
} from '@b64hub/sfpm-core';
import {Org} from '@salesforce/core';

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
  /**
   * Package names that are safe to publish: built successfully, not
   * build-skipped (no source changes — nothing new to publish), and either
   * didn't require validation or passed it.
   */
  publishablePackages: string[];
  /** Whether all validations passed */
  success: boolean;
}

export type {PackageValidationResult} from '@b64hub/sfpm-core';

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
 * 4. Compute which packages are safe to publish (built successfully, not
 *    build-skipped, and validated if validation was required)
 * 5. Report results via GitHub Actions outputs, including the
 *    `publishable-packages` list a downstream publish step can filter on
 *
 * Designed to run in parallel with an install/deploy job right after `build`
 * (both only depend on `build`), so validation polling and a sandbox
 * smoke-test install can happen at the same time. Publishing should wait on
 * this action's `publishable-packages` output rather than running
 * unconditionally against everything the build produced.
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
    return {
      duration: 0, packages: [], publishablePackages: [], success: false,
    };
  }

  const pendingPackages = state.packages.filter(p => p.needsValidation);

  let validationResults: PackageValidationResult[] = [];

  if (pendingPackages.length > 0) {
    logger.info(`Resuming validation for ${pendingPackages.length} unlocked package(s)`);

    // ------------------------------------------------------------------
    // 2. Connect to DevHub
    // ------------------------------------------------------------------
    const devhubUsername = options.devhubUsername ?? state.devhubUsername;
    if (!devhubUsername) {
      core.setFailed('DevHub username required for validation polling');
      return {
        duration: 0, packages: [], publishablePackages: [], success: false,
      };
    }

    logger.info(`Connecting to DevHub: ${devhubUsername}`);
    const devhub = await Org.create({aliasOrUsername: devhubUsername});
    const connection = devhub.getConnection();

    // ------------------------------------------------------------------
    // 3. Poll validation status for each pending package
    // ------------------------------------------------------------------
    logger.group('Validation Polling');

    const maxWaitMs = (options.maxWaitMinutes ?? 120) * 60 * 1000;
    const pollingIntervalMs = (options.pollingIntervalSeconds ?? 30) * 1000;

    const poller = new ValidationPoller(
      connection,
      {maxWaitMs, pollingIntervalMs},
      logger,
    );

    validationResults = await poller.pollAll(pendingPackages.map(pkg => ({
      packageName: pkg.packageName,
      packageVersionCreateRequestId: pkg.packageVersionCreateRequestId!,
      packageVersionId: pkg.packageVersionId,
    })));

    logger.groupEnd();
  } else {
    logger.info('No packages pending validation — nothing to poll');
  }

  // Include non-validation packages as skipped (no async validation was required)
  for (const pkg of state.packages.filter(p => !p.needsValidation)) {
    validationResults.push({
      packageName: pkg.packageName,
      packageVersionId: pkg.packageVersionId,
      status: 'Skipped',
    });
  }

  // ------------------------------------------------------------------
  // 4. Determine which packages are safe to publish
  // ------------------------------------------------------------------
  const publishablePackages = state.packages
  .filter(pkg => {
    // Build failed, or nothing new was built (no source changes) — don't publish.
    if (!pkg.success || pkg.skipped) return false;
    // Didn't require async validation (e.g. Source packages) — build success is enough.
    if (!pkg.needsValidation) return true;
    // Required validation — only publishable if it actually passed.
    return validationResults.find(v => v.packageName === pkg.packageName)?.status === 'Success';
  })
  .map(pkg => pkg.packageName);

  // ------------------------------------------------------------------
  // 5. Set outputs and return
  // ------------------------------------------------------------------
  const duration = Date.now() - startTime;
  const allPassed = validationResults
  .filter(r => r.status !== 'Skipped')
  .every(r => r.status === 'Success');

  const result: BuildResumeResult = {
    duration,
    packages: validationResults,
    publishablePackages,
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
// Helpers
// ============================================================================

function setActionOutputs(result: BuildResumeResult): void {
  core.setOutput('success', String(result.success));
  core.setOutput('duration', String(result.duration));
  core.setOutput('result', JSON.stringify(result));
  core.setOutput('publishable-packages', result.publishablePackages.join(','));

  const validated = result.packages.filter(p => p.status === 'Success');
  const failed = result.packages.filter(p => p.status === 'Error' || p.status === 'TimedOut');

  core.setOutput('validated-count', String(validated.length));
  core.setOutput('failed-count', String(failed.length));
  core.setOutput('failed-packages', failed.map(f => f.packageName).join(','));
}
