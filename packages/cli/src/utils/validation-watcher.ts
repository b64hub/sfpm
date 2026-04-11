/**
 * Validation watcher — standalone script forked by the `build` command.
 *
 * Reads a build state file, authenticates to the DevHub, polls Salesforce
 * for async validation results, sends a desktop notification on completion,
 * and updates the state file with results.
 *
 * Usage (forked by build command):
 *   node validation-watcher.js <state-file-path> <state-id>
 */
import {
  BuildStateStore,
  type LocalBuildState,
  type LocalValidationResult,
  ValidationPoller,
} from '@b64/sfpm-core';
import {Org} from '@salesforce/core';

import {sendNotification} from './notifier.js';

// ============================================================================
// Main
// ============================================================================

const [stateFilePath, stateId] = process.argv.slice(2);

if (!stateFilePath || !stateId) {
  throw new Error('Usage: validation-watcher.js <state-file-path> <state-id>');
}

// Derive project dir from state file path (two levels up from .sfpm/async-builds/)
const projectDir = stateFilePath.replace(/\/.sfpm\/async-builds\/.*$/, '');
const store = new BuildStateStore(projectDir);

const state = await store.load(stateId);
if (!state) {
  throw new Error(`State file not found: ${stateId}`);
}

// Update state with our PID and status
state.watcherPid = process.pid;
state.watcherStatus = 'polling';
await store.update(stateId, state);

try {
  const results = await runPolling(state);

  // Update state with results
  state.results = results;
  state.watcherStatus = 'completed';
  state.updatedAt = Date.now();
  await store.update(stateId, state);

  // Send notification
  const allPassed = results.every(r => r.status === 'Success');
  const failedNames = results.filter(r => r.status !== 'Success').map(r => r.packageName);

  if (allPassed) {
    await sendNotification({
      message: `All ${results.length} package(s) passed validation.`,
      title: 'SFPM: Validation Passed',
    });
  } else {
    await sendNotification({
      message: `Failed: ${failedNames.join(', ')}`,
      title: 'SFPM: Validation Failed',
    });
  }

  if (!allPassed) {
    throw new Error(`Validation failed for: ${failedNames.join(', ')}`);
  }
} catch (error) {
  // Update state with error (unless already completed above)
  if (state.watcherStatus !== 'completed') {
    state.watcherStatus = 'error';
    state.results = [{
      error: error instanceof Error ? error.message : String(error),
      packageName: '*',
      status: 'Error',
    }];
    state.updatedAt = Date.now();
    await store.update(stateId, state);

    await sendNotification({
      message: error instanceof Error ? error.message : String(error),
      title: 'SFPM: Validation Watcher Error',
    });
  }

  throw error;
}

// ============================================================================
// Polling
// ============================================================================

async function runPolling(state: LocalBuildState): Promise<LocalValidationResult[]> {
  // Connect to DevHub using stored username
  const devhub = await Org.create({aliasOrUsername: state.devhubUsername});
  const connection = devhub.getConnection();

  // Build validation targets from packages that have a request ID
  const targets = state.packages
  .filter(pkg => pkg.packageVersionCreateRequestId)
  .map(pkg => ({
    packageName: pkg.packageName,
    packageVersionCreateRequestId: pkg.packageVersionCreateRequestId!,
    packageVersionId: pkg.packageVersionId,
  }));

  if (targets.length === 0) {
    return [];
  }

  // Create a simple console logger for the background process
  const logger = {
    debug: (msg: string) => console.debug(`[sfpm-watcher] ${msg}`),
    error: (msg: string) => console.error(`[sfpm-watcher] ${msg}`),
    info: (msg: string) => console.info(`[sfpm-watcher] ${msg}`),
    log: (msg: string) => console.log(`[sfpm-watcher] ${msg}`),
    trace: (msg: string) => console.debug(`[sfpm-watcher] ${msg}`),
    warn: (msg: string) => console.warn(`[sfpm-watcher] ${msg}`),
  };

  const poller = new ValidationPoller(
    connection,
    {maxWaitMs: state.waitTimeMs, pollingIntervalMs: 30_000},
    logger,
  );

  const results = await poller.pollAll(targets);

  return results.map(r => ({
    codeCoverage: r.codeCoverage,
    error: r.error,
    hasPassedCodeCoverageCheck: r.hasPassedCodeCoverageCheck,
    packageName: r.packageName,
    packageVersionId: r.packageVersionId,
    status: r.status as 'Error' | 'Success' | 'TimedOut',
  }));
}
