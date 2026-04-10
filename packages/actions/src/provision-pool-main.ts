import type {SandboxLicenseType} from '@b64/sfpm-orgs';

import * as core from '@actions/core';
import {OrgTypes} from '@salesforce/core';

import {provisionPool} from './provision-pool.js';

// ============================================================================
// Action Entry Point
// ============================================================================

try {
  const devhubUsername = core.getInput('devhub-username', {required: true});
  const tag = core.getInput('pool-tag', {required: true});
  const maxAllocation = Number.parseInt(core.getInput('max-allocation', {required: true}), 10);

  const poolTypeInput = core.getInput('pool-type') || 'scratchOrg';
  const poolType = poolTypeInput === 'sandbox' ? OrgTypes.Sandbox : OrgTypes.Scratch;

  const batchSize = core.getInput('batch-size')
    ? Number.parseInt(core.getInput('batch-size'), 10)
    : undefined;
  const definitionFile = core.getInput('definition-file') || undefined;
  const expiryDays = core.getInput('expiry-days')
    ? Number.parseInt(core.getInput('expiry-days'), 10)
    : undefined;
  const licenseType = (core.getInput('license-type') || undefined) as SandboxLicenseType | undefined;
  const sandboxNamePattern = core.getInput('sandbox-name-pattern') || undefined;
  const sourceSandboxName = core.getInput('source-sandbox') || undefined;
  const groupName = core.getInput('group-name') || undefined;

  const result = await provisionPool({
    batchSize,
    definitionFile,
    devhubUsername,
    expiryDays,
    groupName,
    licenseType,
    maxAllocation,
    poolType,
    sandboxNamePattern,
    sourceSandboxName,
    tag,
  });

  if (!result.success) {
    // core.setFailed is already called inside provisionPool
    process.exitCode = 1;
  }
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  core.setFailed(message);
  process.exitCode = 1;
}
