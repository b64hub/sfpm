/**
 * Generic watcher runner — standalone script forked by `forkWatcher()`.
 *
 * Reads a watcher state file, resolves the polling strategy from the
 * registry, connects to Salesforce, and polls in a loop until the job
 * completes, fails, or times out.
 *
 * Usage (forked by forkWatcher):
 *   node watcher-runner.js <state-file-path> <state-id>
 */
import {
  createConsoleLogger,
  resolveStrategy,
  WatcherStateStore,
} from '@b64hub/sfpm-core';

import {sendNotification} from './notifier.js';

// ============================================================================
// Constants
// ============================================================================

const MAX_RETRIES = 3;
const RETRY_BACKOFF_MS = 5000;

// ============================================================================
// Runner
// ============================================================================

async function run(): Promise<void> {
  const [stateFilePath, stateId] = process.argv.slice(2);

  if (!stateFilePath || !stateId) {
    throw new Error('Usage: watcher-runner.js <state-file-path> <state-id>');
  }

  const projectDir = stateFilePath.replace(/\/.sfpm\/watchers\/.*$/, '');
  const store = new WatcherStateStore(projectDir);
  const logger = createConsoleLogger({level: 'info'});

  const state = await store.load(stateId);
  if (!state) {
    throw new Error(`State file not found: ${stateId}`);
  }

  // Update state with our PID and status
  state.watcherPid = process.pid;
  state.watcherStatus = 'polling';
  await store.update(stateId, state);

  try {
    // Resolve the polling strategy
    const strategy = resolveStrategy(state.jobType);

    // Connect to Salesforce
    logger.info(`Connecting to ${state.auth.username} for ${state.jobType} watcher`);
    const connection = await strategy.connect(state.auth);

    // Calculate timing
    const intervalMs = state.intervalMs ?? strategy.defaultIntervalMs;
    const timeoutMs = state.timeoutMs ?? strategy.defaultTimeoutMs;
    const deadline = Date.now() + timeoutMs;

    let consecutiveErrors = 0;

    // Poll loop
    while (Date.now() < deadline) {
      try {
        // eslint-disable-next-line no-await-in-loop
        const outcome = await strategy.poll(connection, state.payload);

        consecutiveErrors = 0; // Reset on successful poll

        if (outcome.status === 'completed') {
          state.result = outcome.result;
          state.watcherStatus = 'completed';
          state.updatedAt = Date.now();
          // eslint-disable-next-line no-await-in-loop
          await store.update(stateId, state);

          // eslint-disable-next-line no-await-in-loop
          await sendNotification({
            message: `${state.jobType} job completed successfully.`,
            title: `SFPM: ${capitalize(state.jobType)} Complete`,
          });

          return;
        }

        if (outcome.status === 'failed') {
          state.result = outcome.result;
          state.error = outcome.error;
          state.watcherStatus = 'error';
          state.updatedAt = Date.now();
          // eslint-disable-next-line no-await-in-loop
          await store.update(stateId, state);

          // eslint-disable-next-line no-await-in-loop
          await sendNotification({
            message: outcome.error,
            title: `SFPM: ${capitalize(state.jobType)} Failed`,
          });

          throw new Error(outcome.error);
        }

        // Still pending — log progress and continue
        if (outcome.message) {
          logger.info(`[${state.jobType}] ${outcome.message}`);
        }
      } catch (error) {
        // Re-throw terminal errors (already persisted above)
        if (state.watcherStatus === 'error') throw error;

        consecutiveErrors++;
        const errorMessage = error instanceof Error ? error.message : String(error);
        logger.warn(`Poll error (${consecutiveErrors}/${MAX_RETRIES}): ${errorMessage}`);

        if (consecutiveErrors >= MAX_RETRIES) {
          throw new Error(`Polling failed after ${MAX_RETRIES} consecutive errors: ${errorMessage}`);
        }

        // Backoff before retrying
        // eslint-disable-next-line no-await-in-loop
        await sleep(RETRY_BACKOFF_MS * consecutiveErrors);
        continue;
      }

      // eslint-disable-next-line no-await-in-loop
      await sleep(intervalMs);
    }

    // Timed out
    state.error = `Timed out after ${Math.round(timeoutMs / 60_000)} minutes`;
    state.watcherStatus = 'error';
    state.updatedAt = Date.now();
    await store.update(stateId, state);

    await sendNotification({
      message: state.error,
      title: `SFPM: ${capitalize(state.jobType)} Timed Out`,
    });

    throw new Error(state.error);
  } catch (error) {
    // Unexpected error — update state and notify
    if (state.watcherStatus !== 'completed' && state.watcherStatus !== 'error') {
      state.watcherStatus = 'error';
      state.error = error instanceof Error ? error.message : String(error);
      state.updatedAt = Date.now();
      await store.update(stateId, state);

      await sendNotification({
        message: state.error,
        title: `SFPM: ${capitalize(state.jobType)} Watcher Error`,
      });
    }

    throw error;
  }
}

// ============================================================================
// Helpers
// ============================================================================

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => {
    setTimeout(resolve, ms);
  });
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

// ============================================================================
// Entry point
// ============================================================================

try {
  await run();
} catch (error) {
  console.error(error);
  process.exitCode = 1;
}
