import * as core from '@actions/core';

import {buildResume} from './build-resume.js';

// ============================================================================
// Action Entry Point
// ============================================================================

try {
  const devhubUsername = core.getInput('devhub-username') || undefined;
  const projectDir = core.getInput('project-dir') || undefined;
  const runId = core.getInput('run-id') || undefined;

  const maxWaitMinutes = core.getInput('max-wait-minutes')
    ? Number.parseInt(core.getInput('max-wait-minutes'), 10)
    : undefined;
  const pollingIntervalSeconds = core.getInput('polling-interval-seconds')
    ? Number.parseInt(core.getInput('polling-interval-seconds'), 10)
    : undefined;

  const result = await buildResume({
    devhubUsername,
    maxWaitMinutes,
    pollingIntervalSeconds,
    projectDir,
    runId,
  });

  if (!result.success) {
    process.exitCode = 1;
  }
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  core.setFailed(message);
  process.exitCode = 1;
}
