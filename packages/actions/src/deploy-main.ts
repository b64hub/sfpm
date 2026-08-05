import * as core from '@actions/core';
import {type TestLevel} from '@b64hub/sfpm-core';

import {install} from './install.js';

// ============================================================================
// Action Entry Point
// ============================================================================

/**
 * Pre-configured variant of the install action: always deploys unlocked
 * packages as source (`sourceOnly: true`) instead of installing a package
 * version. Useful for deploying straight from published artifacts without
 * consuming/needing an installation key.
 */
try {
  const targetOrg = core.getInput('target-org', {required: true});
  const packagesInput = core.getInput('packages', {required: true});
  const packages = packagesInput.split(',').map(p => p.trim()).filter(Boolean);

  const projectDir = core.getInput('project-dir') || undefined;
  const testLevel = core.getInput('test-level') || undefined;

  const force = core.getInput('force') === 'true';
  const includeDependencies = core.getInput('include-dependencies') !== 'false';
  const regressionTest = core.getInput('regression-test') === 'true';

  const result = await install({
    force,
    includeDependencies,
    packages,
    projectDir,
    regressionTest,
    sourceOnly: true,
    targetOrg,
    testLevel: testLevel as TestLevel | undefined,
  });

  if (!result.success) {
    process.exitCode = 1;
  }
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  core.setFailed(message);
  process.exitCode = 1;
}
