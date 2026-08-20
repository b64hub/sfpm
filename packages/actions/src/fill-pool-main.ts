import * as core from '@actions/core';
import {OrgTypes} from '@salesforce/core';

import {fillPool} from './fill-pool.js';

// ============================================================================
// Action Entry Point
// ============================================================================

try {
  const devhubUsername = core.getInput('devhub-username', {required: true});
  // Accepts multiple pool tags, one per line or comma-separated, to fill several pools in one run.
  const tag = core.getInput('pool-tag', {required: true}).split(/[\n,]/).map(t => t.trim()).filter(Boolean);
  const maxAllocation = core.getInput('max-allocation')
    ? Number.parseInt(core.getInput('max-allocation'), 10)
    : undefined;

  const poolTypeInput = core.getInput('pool-type') || undefined;
  const poolType = poolTypeInput === 'sandbox' ? OrgTypes.Sandbox : poolTypeInput === 'scratch' ? OrgTypes.Scratch : undefined;

  const batchSize = core.getInput('batch-size')
    ? Number.parseInt(core.getInput('batch-size'), 10)
    : undefined;
  const definitionFile = core.getInput('definition-file') || undefined;
  const expiryDays = core.getInput('expiry-days')
    ? Number.parseInt(core.getInput('expiry-days'), 10)
    : undefined;
  const projectDir = core.getInput('project-dir') || undefined;
  const sandboxNamePattern = core.getInput('sandbox-name-pattern') || undefined;
  const useLocalSource = core.getInput('use-local-source') === 'true';

  const result = await fillPool({
    batchSize,
    definitionFile,
    devhubUsername,
    expiryDays,
    maxAllocation,
    poolType,
    projectDir,
    sandboxNamePattern,
    tag,
    useLocalSource,
  });

  if (!result.success) {
    // core.setFailed is already called inside fillPool
    process.exitCode = 1;
  }
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  core.setFailed(message);
  process.exitCode = 1;
}
