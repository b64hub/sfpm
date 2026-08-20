import * as core from '@actions/core';
import {OrgTypes} from '@salesforce/core';

import {cleanPool} from './clean-pool.js';

// ============================================================================
// Action Entry Point
// ============================================================================

try {
  const devhubUsername = core.getInput('devhub-username', {required: true});
  // Accepts multiple pool tags, one per line or comma-separated, to clean several pools in one run.
  const tag = core.getInput('pool-tag', {required: true}).split(/[\n,]/).map(t => t.trim()).filter(Boolean);

  const poolTypeInput = core.getInput('pool-type') || undefined;
  const poolType = poolTypeInput === 'sandbox' ? OrgTypes.Sandbox : poolTypeInput === 'scratch' ? OrgTypes.Scratch : undefined;

  const inProgressOnly = core.getInput('in-progress-only') === 'true';
  const myPool = core.getInput('my-pool') === 'true';

  const result = await cleanPool({
    devhubUsername,
    inProgressOnly,
    myPool,
    poolType,
    tag,
  });

  if (!result.success) {
    // core.setFailed is already called inside cleanPool
    process.exitCode = 1;
  }
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  core.setFailed(message);
  process.exitCode = 1;
}
