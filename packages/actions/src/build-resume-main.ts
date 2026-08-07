import * as core from '@actions/core';

import {buildResume} from './build-resume.js';

// ============================================================================
// Action Entry Point
// ============================================================================

try {
  const buildResult = core.getInput('build-result', {required: true});
  const projectDir = core.getInput('project-dir') || undefined;

  const packagesInput = core.getInput('packages') || '';
  const packages = packagesInput
    ? packagesInput.split(',').map(p => p.trim()).filter(Boolean)
    : undefined;

  const maxWaitMinutes = core.getInput('max-wait-minutes')
    ? Number.parseInt(core.getInput('max-wait-minutes'), 10)
    : undefined;
  const pollingIntervalSeconds = core.getInput('polling-interval-seconds')
    ? Number.parseInt(core.getInput('polling-interval-seconds'), 10)
    : undefined;

  const result = await buildResume({
    buildResult,
    maxWaitMinutes,
    packages,
    pollingIntervalSeconds,
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
