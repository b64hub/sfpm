/**
 * Validation runner — standalone script forked by the build command's `--async` path.
 *
 * Runs `ValidationResolver.resolve()` in a detached background process.
 * Handles both deploy validation (install orchestration) and package-version-request
 * polling in a single pass — no poll loop needed.
 *
 * Usage (forked by forkWatcher):
 *   node validation-runner.js <state-file-path> <state-id>
 */
import type {
  BuildWatcherPayload, WatcherState,
} from '@b64hub/sfpm-core';

import {
  createConsoleLogger,
  ProjectService,
  ValidationResolver,
  WatcherStateStore,
} from '@b64hub/sfpm-core';

import {sendNotification} from './notifier.js';

async function run(): Promise<void> {
  const [stateFilePath, stateId] = process.argv.slice(2);

  if (!stateFilePath || !stateId) {
    throw new Error('Usage: validation-runner.js <state-file-path> <state-id>');
  }

  const projectDir = stateFilePath.replace(/\/.sfpm\/watchers\/.*$/, '');
  const store = new WatcherStateStore(projectDir);
  const logger = createConsoleLogger({level: 'info'});

  const state = await store.load(stateId) as undefined | WatcherState<BuildWatcherPayload>;
  if (!state) {
    throw new Error(`State file not found: ${stateId}`);
  }

  state.watcherPid = process.pid;
  state.watcherStatus = 'polling';
  await store.update(stateId, state);

  try {
    const projectService = await ProjectService.getInstance(projectDir);
    const resolver = new ValidationResolver(
      projectService.getDefinitionProvider(),
      projectService.getProjectGraph(),
      logger,
    );

    logger.info(`Resolving ${state.payload.validations.length} validation(s)`);
    const results = await resolver.resolve(state.payload.validations);

    // Check for failures
    const failures: string[] = [];
    for (const [packageName, result] of results) {
      if (result.status === 'failed') {
        failures.push(`${packageName}: ${result.error}`);
      }
    }

    const resultPayload = Object.fromEntries(results);

    if (failures.length > 0) {
      state.watcherStatus = 'error';
      state.error = `Validation failed for ${failures.length} package(s)`;
      state.result = resultPayload;
      state.updatedAt = Date.now();
      await store.update(stateId, state);
      await notify(`Failed — ${failures.length} package(s)`, failures.join('; '));
      return;
    }

    state.watcherStatus = 'completed';
    state.result = resultPayload;
    state.updatedAt = Date.now();
    await store.update(stateId, state);
    await notify('Complete', `All ${results.size} validation(s) passed`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    state.watcherStatus = 'error';
    state.error = message;
    state.updatedAt = Date.now();
    await store.update(stateId, state);
    await notify('Error', message);
    throw error;
  }
}

async function notify(label: string, message: string): Promise<void> {
  await sendNotification({
    message,
    title: `SFPM: Validation ${label}`,
  });
}

try {
  await run();
} catch (error) {
  console.error(error);
  process.exitCode = 1;
}
