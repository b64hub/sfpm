import * as core from '@actions/core';
import {OrgTypes} from '@salesforce/core';

import {validatePr} from './validate-pr.js';

// ============================================================================
// Action Entry Point
// ============================================================================

try {
  const devhubUsername = core.getInput('devhub-username') || undefined;
  const modeInput = core.getInput('mode') || 'local';

  if (modeInput !== 'local' && modeInput !== 'org') {
    throw new Error(`Invalid mode "${modeInput}" — must be "local" or "org"`);
  }

  const poolTag = core.getInput('pool-tag') || undefined;
  const poolTypeInput = core.getInput('pool-type') || undefined;
  const poolType = poolTypeInput === 'sandbox' ? OrgTypes.Sandbox : poolTypeInput === 'scratch' ? OrgTypes.Scratch : undefined;
  const baseRef = core.getInput('base-ref') || undefined;
  const cacheTtlHours = Number.parseInt(core.getInput('cache-ttl-hours') || '4', 10);
  const projectDir = core.getInput('project-dir') || undefined;
  const packagesInput = core.getInput('packages') || '';
  const packages = packagesInput
    ? packagesInput.split(',').map(p => p.trim()).filter(Boolean)
    : undefined;

  const result = await validatePr({
    baseRef,
    cacheTtlHours,
    devhubUsername,
    mode: modeInput,
    packages,
    poolTag,
    poolType,
    projectDir,
  });

  if (!result.success) {
    // core.setFailed is already called inside validatePr
    process.exitCode = 1;
  }
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  core.setFailed(message);
  process.exitCode = 1;
}
