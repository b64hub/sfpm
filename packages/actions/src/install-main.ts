import * as core from '@actions/core';
import {type TestLevel} from '@b64hub/sfpm-core';

import {install} from './install.js';

// ============================================================================
// Action Entry Point
// ============================================================================

try {
  const targetOrg = core.getInput('target-org', {required: true});
  const packagesInput = core.getInput('packages', {required: true});
  const packages = packagesInput.split(',').map(p => p.trim()).filter(Boolean);

  const projectDir = core.getInput('project-dir') || undefined;
  const installationKey = core.getInput('installation-key') || undefined;
  const testLevel = core.getInput('test-level') || undefined;

  const force = core.getInput('force') === 'true';
  const includeDependencies = core.getInput('include-dependencies') !== 'false';
  const regressionTest = core.getInput('regression-test') === 'true';

  const result = await install({
    force,
    includeDependencies,
    installationKey,
    packages,
    projectDir,
    regressionTest,
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
