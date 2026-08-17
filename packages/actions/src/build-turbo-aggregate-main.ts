import * as core from '@actions/core';

import {buildTurboAggregate} from './build-turbo-aggregate.js';

// ============================================================================
// Action Entry Point
// ============================================================================

try {
  const projectDir = core.getInput('project-dir') || undefined;
  const taskName = core.getInput('task-name') || undefined;

  const packagesInput = core.getInput('packages') || '';
  const packages = packagesInput
    ? packagesInput.split(',').map(p => p.trim()).filter(Boolean)
    : undefined;

  const result = await buildTurboAggregate({packages, projectDir, taskName});

  if (!result.success) {
    process.exitCode = 1;
  }
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  core.setFailed(message);
  process.exitCode = 1;
}
