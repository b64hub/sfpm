import * as core from '@actions/core';
import {parseInstallationKeys, type TestLevel} from '@b64hub/sfpm-core';

import {install} from './install.js';

// ============================================================================
// Action Entry Point
// ============================================================================

try {
  const targetOrg = core.getInput('target-org', {required: true});
  const packagesInput = core.getInput('packages', {required: true});
  const packages = packagesInput.split(',').map(p => p.trim()).filter(Boolean);

  const projectDir = core.getInput('project-dir') || undefined;
  const installationKeysInput = core.getInput('installation-keys') || '';
  const installationKeys = installationKeysInput
    ? parseInstallationKeys(installationKeysInput.split('\n').map(l => l.trim()).filter(Boolean))
    : undefined;
  const testLevel = core.getInput('test-level') || undefined;
  const origin = core.getInput('origin') || undefined;

  if (origin && origin !== 'registry' && origin !== 'local') {
    throw new Error(`Invalid origin "${origin}" — must be "registry" or "local"`);
  }

  const force = core.getInput('force') === 'true';
  const includeDependencies = core.getInput('include-dependencies') !== 'false';
  const regressionTest = core.getInput('regression-test') === 'true';

  const result = await install({
    force,
    includeDependencies,
    installationKeys,
    origin: origin as 'local' | 'registry' | undefined,
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
