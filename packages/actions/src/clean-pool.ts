import * as core from '@actions/core';
import {createPoolServices} from '@b64hub/sfpm-orgs';
import {Org, OrgTypes} from '@salesforce/core';

import {createGitHubActionsLogger} from './logger.js';

// ============================================================================
// Types
// ============================================================================

export interface CleanPoolOptions {
  /** DevHub username or alias */
  devhubUsername: string;
  /** Only delete orgs with 'InProgress' stage */
  inProgressOnly?: boolean;
  /** Only delete orgs created by the current user */
  myPool?: boolean;
  /** Pool type: scratch or sandbox (default: scratch) */
  poolType?: OrgTypes;
  /** Pool tag(s) to delete orgs from — pass an array to clean multiple pools in one run */
  tag: string | string[];
}

export interface CleanPoolResult {
  /** Number of orgs deleted */
  deleted: number;
  /** Duration in milliseconds */
  duration: number;
  /** Error messages from failed deletions */
  errors: string[];
  /** Usernames of deleted orgs */
  orgUsernames: string[];
  /** Whether all matching orgs were deleted successfully */
  success: boolean;
  /** The pool tag */
  tag: string;
}

export interface CleanPoolReport {
  /** Total number of orgs deleted across all pools */
  deleted: number;
  /** Total duration across all pools, in milliseconds */
  duration: number;
  /** Per-pool deletion results */
  results: CleanPoolResult[];
  /** Whether every pool was cleaned successfully */
  success: boolean;
}

// ============================================================================
// Pool Cleanup
// ============================================================================

/**
 * Main entry point for the pool cleanup GitHub Action — deletes orgs from a
 * pool. Mirrors the CLI's `pool delete` command (see `PoolDelete` in
 * `@b64hub/sfpm-cli`).
 */
export async function cleanPool(options: CleanPoolOptions): Promise<CleanPoolReport> {
  const logger = createGitHubActionsLogger({prefix: 'clean-pool'});
  const startTime = Date.now();
  const poolType = options.poolType ?? OrgTypes.Scratch;
  const tags = Array.isArray(options.tag) ? options.tag : [options.tag];

  logger.info(`Pool type: ${poolType}`);
  logger.info(`DevHub: ${options.devhubUsername}`);

  logger.info('Connecting to hub org...');
  const devhub = await Org.create({aliasOrUsername: options.devhubUsername});

  const results: CleanPoolResult[] = [];
  for (const tag of tags) {
    // Tag-scoped logger — a fresh prefixed instance rather than `.child()`,
    // since `GitHubActionsLogger.child()` buffers for the package-flush
    // mechanism and is never flushed for pool tags.
    const tagLogger = createGitHubActionsLogger({prefix: `clean-pool:${tag}`});
    const {manager} = createPoolServices({devhub, logger: tagLogger, poolType});

    // eslint-disable-next-line no-await-in-loop -- pools are cleaned sequentially
    const deleteResult = await manager.delete(tag, {
      inProgressOnly: options.inProgressOnly,
      myPool: options.myPool,
    });

    results.push({
      deleted: deleteResult.deleted.length,
      duration: deleteResult.elapsedMs,
      errors: deleteResult.errors,
      orgUsernames: deleteResult.deleted.map(org => org.auth.username).filter(Boolean),
      success: deleteResult.errors.length === 0,
      tag: deleteResult.tag,
    });
  }

  const report: CleanPoolReport = {
    deleted: results.reduce((sum, r) => sum + r.deleted, 0),
    duration: Date.now() - startTime,
    results,
    success: results.every(r => r.success),
  };

  setActionOutputs(report);

  for (const result of results) {
    if (result.success) {
      logger.info(`Pool "${result.tag}" cleaned: deleted ${result.deleted} org(s) in ${Math.round(result.duration / 1000)}s`);
    } else if (result.deleted > 0) {
      core.warning(`Pool "${result.tag}" cleanup partially failed: ${result.deleted} deleted, ${result.errors.length} error(s)`);
    } else {
      core.error(`Pool "${result.tag}" cleanup failed: ${result.errors.join(', ')}`);
    }
  }

  if (!report.success) {
    core.setFailed(`Pool cleanup failed for: ${results.filter(r => !r.success).map(r => r.tag).join(', ')}`);
  }

  return report;
}

// ============================================================================
// Helpers
// ============================================================================

function setActionOutputs(report: CleanPoolReport): void {
  core.setOutput('success', String(report.success));
  core.setOutput('tag', report.results.map(r => r.tag).join(','));
  core.setOutput('deleted', String(report.deleted));
  core.setOutput('duration', String(report.duration));
  core.setOutput('org-usernames', report.results.flatMap(r => r.orgUsernames).join(','));
  core.setOutput('result', JSON.stringify(report));
}
