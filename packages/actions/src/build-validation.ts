import * as core from '@actions/core';
import {
  type PendingValidationDescriptor,
  ProjectService,
  ValidationEventBus,
  ValidationResolver,
  type ValidationState,
} from '@b64hub/sfpm-core';

import type {BuildResult, PackageBuildState} from './build.js';

import {createGitHubActionsLogger} from './logger.js';

// ============================================================================
// Types
// ============================================================================

export interface BuildValidationOptions {
  /** JSON `result` output from the `build` action/job (e.g. `needs.build.outputs.result`) */
  buildResult: string;
  /** Maximum time to wait for validation in minutes (default: 120) */
  maxWaitMinutes?: number;
  /** Restrict validation resolution to this subset of package names (default: all pending) */
  packages?: string[];
  /** Polling interval in seconds (default: 30) */
  pollingIntervalSeconds?: number;
  /** Project directory (default: workspace root) */
  projectDir?: string;
}

export interface PackageValidationOutcome {
  /** Code coverage percentage (if available) */
  codeCoverage?: number;
  /** Error message if validation failed */
  error?: string;
  /** Package name */
  packageName: string;
  /** Final validation status */
  status: 'Error' | 'Skipped' | 'Success';
}

export interface BuildValidationResult {
  /** Duration of the resume step in milliseconds */
  duration: number;
  /** Per-package validation outcomes */
  packages: PackageValidationOutcome[];
  /**
   * Package names that are safe to publish: built successfully, not
   * build-skipped (no source changes — nothing new to publish), and either
   * didn't require validation or passed it.
   */
  publishablePackages: string[];
  /** Whether all resolved validations passed */
  success: boolean;
}

// ============================================================================
// Build Validation Pipeline
// ============================================================================

/**
 * Resume a build workflow by resolving pending async validation for
 * unlocked packages.
 *
 * Workflow:
 * 1. Parse the `build` job's `result` output (its `packages[]` already carry
 *    a {@link PendingValidationDescriptor} for any unlocked package that
 *    queued async validation — no cache, no run-ID lookup needed)
 * 2. Optionally narrow to a subset via `packages` (e.g. resume validation
 *    for only specific unlocked packages)
 * 3. Resolve the descriptors via {@link ValidationResolver}, which polls the
 *    DevHub named on each descriptor directly (no devhub-username input needed)
 * 4. Compute which packages are safe to publish (built successfully, not
 *    build-skipped, and validated if validation was required)
 * 5. Report results via GitHub Actions outputs, including the
 *    `publishable-packages` list a downstream publish step can filter on
 *
 * Designed to run in parallel with an install/deploy job right after `build`
 * (both only depend on `build`). Publishing should wait on this action's
 * `publishable-packages` output rather than running unconditionally against
 * everything the build produced.
 *
 * @example
 * ```typescript
 * const result = await buildValidation({
 *   buildResult: coreGetInput('build-result'),
 *   maxWaitMinutes: 120,
 * });
 * ```
 */
export async function buildValidation(options: BuildValidationOptions): Promise<BuildValidationResult> {
  const logger = createGitHubActionsLogger({prefix: 'build-validation'});
  const startTime = Date.now();

  // ------------------------------------------------------------------
  // 1. Parse the build job's result
  // ------------------------------------------------------------------
  let state: BuildResult;
  try {
    state = JSON.parse(options.buildResult) as BuildResult;
  } catch {
    core.setFailed('Invalid build-result input — expected the JSON `result` output from the build action');
    return {
      duration: 0, packages: [], publishablePackages: [], success: false,
    };
  }

  const pendingAll = state.packages.filter((p): p is PackageBuildState & {pendingValidation: PendingValidationDescriptor} => Boolean(p.pendingValidation));

  // ------------------------------------------------------------------
  // 2. Narrow to the requested subset, if any
  // ------------------------------------------------------------------
  const pending = options.packages?.length
    ? pendingAll.filter(p => options.packages!.includes(p.packageName))
    : pendingAll;

  let resolved = new Map<string, Extract<ValidationState, {status: 'failed' | 'passed'}>>();

  if (pending.length > 0) {
    logger.info(`Resolving validation for ${pending.length} package(s): ${pending.map(p => p.packageName).join(', ')}`);

    // ------------------------------------------------------------------
    // 3. Resolve pending validations
    // ------------------------------------------------------------------
    const projectDir = options.projectDir ?? process.env.GITHUB_WORKSPACE ?? process.cwd();
    const projectService = await ProjectService.getInstance(projectDir);
    const projectConfig = projectService.getDefinitionProvider();
    const projectGraph = projectService.getProjectGraph();

    logger.group('Validation Resolution');

    const resolver = new ValidationResolver(projectConfig, projectGraph, logger, new ValidationEventBus());
    resolved = await resolver.resolve(
      pending.map(p => p.pendingValidation),
      {
        maxWaitMs: (options.maxWaitMinutes ?? 120) * 60 * 1000,
        pollingIntervalMs: (options.pollingIntervalSeconds ?? 30) * 1000,
      },
    );

    logger.groupEnd();
  } else {
    logger.info('No pending validations to resolve');
  }

  // ------------------------------------------------------------------
  // 4. Build per-package outcomes and determine publishable packages
  // ------------------------------------------------------------------
  const packages: PackageValidationOutcome[] = [];
  for (const pkg of state.packages) {
    if (!pkg.pendingValidation) {
      packages.push({packageName: pkg.packageName, status: 'Skipped'});
      continue;
    }

    const validationState = resolved.get(pkg.packageName);
    if (!validationState) continue; // not part of this resolve call (subset filter)

    packages.push(validationState.status === 'passed'
      ? {codeCoverage: validationState.testCoverage, packageName: pkg.packageName, status: 'Success'}
      : {error: validationState.error, packageName: pkg.packageName, status: 'Error'});
  }

  const publishablePackages = state.packages
  .filter(pkg => {
    // Build failed, or nothing new was built (no source changes) — don't publish.
    if (!pkg.success || pkg.skipped) return false;
    // Didn't require async validation (e.g. Source packages) — build success is enough.
    if (!pkg.pendingValidation) return true;
    // Required validation — only publishable if it actually passed.
    return resolved.get(pkg.packageName)?.status === 'passed';
  })
  .map(pkg => pkg.packageName);

  // ------------------------------------------------------------------
  // 5. Set outputs and return
  // ------------------------------------------------------------------
  const duration = Date.now() - startTime;
  const allPassed = packages
  .filter(p => p.status !== 'Skipped')
  .every(p => p.status === 'Success');

  const result: BuildValidationResult = {
    duration,
    packages,
    publishablePackages,
    success: allPassed,
  };

  setActionOutputs(result);

  if (allPassed) {
    logger.info(`All validations passed in ${Math.round(duration / 1000)}s`);
  } else {
    const failed = packages.filter(p => p.status === 'Error');
    core.setFailed(`Validation failed for: ${failed.map(f => f.packageName).join(', ')}`);
  }

  return result;
}

// ============================================================================
// Helpers
// ============================================================================

function setActionOutputs(result: BuildValidationResult): void {
  core.setOutput('success', String(result.success));
  core.setOutput('duration', String(result.duration));
  core.setOutput('result', JSON.stringify(result));
  core.setOutput('publishable-packages', result.publishablePackages.join(','));

  const validated = result.packages.filter(p => p.status === 'Success');
  const failed = result.packages.filter(p => p.status === 'Error');

  core.setOutput('validated-count', String(validated.length));
  core.setOutput('failed-count', String(failed.length));
  core.setOutput('failed-packages', failed.map(f => f.packageName).join(','));
}
