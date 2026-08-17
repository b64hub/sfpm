import * as core from '@actions/core';
import {parseInstallationKeys} from '@b64hub/sfpm-core';

import {build} from './build.js';

// ============================================================================
// Action Entry Point
// ============================================================================

try {
  const devhubUsername = core.getInput('devhub-username') || undefined;
  const projectDir = core.getInput('project-dir') || undefined;
  const buildNumber = core.getInput('build-number') || undefined;
  const installationKeysInput = core.getInput('installation-keys') || '';
  const installationKeys = installationKeysInput
    ? parseInstallationKeys(installationKeysInput.split('\n').map(l => l.trim()).filter(Boolean))
    : undefined;

  const packagesInput = core.getInput('packages') || '';
  const packages = packagesInput
    ? packagesInput.split(',').map(p => p.trim()).filter(Boolean)
    : undefined;

  const force = core.getInput('force') === 'true';
  const includeDependencies = core.getInput('include-dependencies') !== 'false';

  const result = await build({
    buildNumber,
    devhubUsername,
    force,
    includeDependencies,
    installationKeys,
    packages,
    projectDir,
  });

  if (!result.success) {
    process.exitCode = 1;
  }
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  core.setFailed(message);
  process.exitCode = 1;
}
