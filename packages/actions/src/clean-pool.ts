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
  /** Pool tag to delete orgs from */
  tag: string;
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

// ============================================================================
// Pool Cleanup
// ============================================================================

/**
 * Main entry point for the pool cleanup GitHub Action — deletes orgs from a
 * pool. Mirrors the CLI's `pool delete` command (see `PoolDelete` in
 * `@b64hub/sfpm-cli`).
 */
export async function cleanPool(options: CleanPoolOptions): Promise<CleanPoolResult> {
  const logger = createGitHubActionsLogger({prefix: 'clean-pool'});
  const startTime = Date.now();
  const poolType = options.poolType ?? OrgTypes.Scratch;

  logger.info(`Pool tag: ${options.tag}`);
  logger.info(`Pool type: ${poolType}`);
  logger.info(`DevHub: ${options.devhubUsername}`);

  logger.info('Connecting to hub org...');
  const devhub = await Org.create({aliasOrUsername: options.devhubUsername});

  const {manager} = createPoolServices({devhub, logger, poolType});

  const deleteResult = await manager.delete(options.tag, {
    inProgressOnly: options.inProgressOnly,
    myPool: options.myPool,
  });

  const duration = Date.now() - startTime;
  const result: CleanPoolResult = {
    deleted: deleteResult.deleted.length,
    duration,
    errors: deleteResult.errors,
    orgUsernames: deleteResult.deleted.map(org => org.auth.username).filter(Boolean),
    success: deleteResult.errors.length === 0,
    tag: deleteResult.tag,
  };

  setActionOutputs(result);

  if (result.success) {
    logger.info(`Pool "${options.tag}" cleaned: deleted ${result.deleted} org(s) in ${Math.round(duration / 1000)}s`);
  } else if (result.deleted > 0) {
    core.warning(`Pool cleanup partially failed: ${result.deleted} deleted, ${result.errors.length} error(s)`);
  } else {
    core.setFailed(`Pool cleanup failed: ${result.errors.join(', ')}`);
  }

  return result;
}

// ============================================================================
// Helpers
// ============================================================================

function setActionOutputs(result: CleanPoolResult): void {
  core.setOutput('success', String(result.success));
  core.setOutput('tag', result.tag);
  core.setOutput('deleted', String(result.deleted));
  core.setOutput('duration', String(result.duration));
  core.setOutput('org-usernames', result.orgUsernames.join(','));
  core.setOutput('result', JSON.stringify(result));
}
