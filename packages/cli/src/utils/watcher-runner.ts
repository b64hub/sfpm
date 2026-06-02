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
import type {
  Logger, PollingStrategy, PollOutcome, WatcherState,
} from '@b64hub/sfpm-core';
import type {Connection} from '@salesforce/core';

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

  state.watcherPid = process.pid;
  state.watcherStatus = 'polling';
  await store.update(stateId, state);

  try {
    const strategy = resolveStrategy(state.jobType);
    logger.info(`Connecting to ${state.auth.username} for ${state.jobType} watcher`);
    const connection = await strategy.connect(state.auth);
    await pollUntilDone(strategy, connection, state, store, stateId, logger);
  } catch (error) {
    await handleFatalError(error, state, store, stateId);
    throw error;
  }
}

// ============================================================================
// Poll loop
// ============================================================================

async function pollUntilDone(
  strategy: PollingStrategy,
  connection: Connection,
  state: WatcherState,
  store: WatcherStateStore,
  stateId: string,
  logger: Logger,
): Promise<void> {
  const intervalMs = state.intervalMs ?? strategy.defaultIntervalMs;
  const timeoutMs = state.timeoutMs ?? strategy.defaultTimeoutMs;
  const deadline = Date.now() + timeoutMs;
  let consecutiveErrors = 0;

  while (Date.now() < deadline) {
    try {
      // eslint-disable-next-line no-await-in-loop
      const outcome = await strategy.poll(connection, state.payload);
      consecutiveErrors = 0;

      // eslint-disable-next-line no-await-in-loop
      const handled = await handleOutcome(outcome, state, store, stateId, logger);
      if (handled) return;
    } catch (error) {
      if (state.watcherStatus === 'error') throw error;

      consecutiveErrors++;
      const msg = error instanceof Error ? error.message : String(error);
      logger.warn(`Poll error (${consecutiveErrors}/${MAX_RETRIES}): ${msg}`);

      if (consecutiveErrors >= MAX_RETRIES) {
        throw new Error(`Polling failed after ${MAX_RETRIES} consecutive errors: ${msg}`);
      }

      // eslint-disable-next-line no-await-in-loop
      await sleep(RETRY_BACKOFF_MS * consecutiveErrors);
      continue;
    }

    // eslint-disable-next-line no-await-in-loop
    await sleep(intervalMs);
  }

  await markError(state, store, stateId, `Timed out after ${Math.round(timeoutMs / 60_000)} minutes`);
  await notify(state, 'Timed Out', state.error!);
  throw new Error(state.error);
}

// ============================================================================
// Outcome handling
// ============================================================================

/**
 * Process a single poll outcome. Returns `true` if the poll loop should exit.
 */
async function handleOutcome(
  outcome: PollOutcome<unknown>,
  state: WatcherState,
  store: WatcherStateStore,
  stateId: string,
  logger: Logger,
): Promise<boolean> {
  if (outcome.status === 'completed') {
    state.result = outcome.result;
    state.watcherStatus = 'completed';
    state.updatedAt = Date.now();
    await store.update(stateId, state);
    await notify(state, 'Complete', `${state.jobType} job completed successfully.`);
    return true;
  }

  if (outcome.status === 'failed') {
    await markError(state, store, stateId, outcome.error, outcome.result);
    await notify(state, 'Failed', outcome.error);
    throw new Error(outcome.error);
  }

  if (outcome.message) {
    logger.info(`[${state.jobType}] ${outcome.message}`);
  }

  return false;
}

// ============================================================================
// State helpers
// ============================================================================

async function markError(
  state: WatcherState,
  store: WatcherStateStore,
  stateId: string,
  error: string,
  result?: unknown,
): Promise<void> {
  state.watcherStatus = 'error';
  state.error = error;
  if (result !== undefined) state.result = result;
  state.updatedAt = Date.now();
  await store.update(stateId, state);
}

async function handleFatalError(
  error: unknown,
  state: WatcherState,
  store: WatcherStateStore,
  stateId: string,
): Promise<void> {
  if (state.watcherStatus === 'completed' || state.watcherStatus === 'error') return;

  const message = error instanceof Error ? error.message : String(error);
  await markError(state, store, stateId, message);
  await notify(state, 'Watcher Error', message);
}

// ============================================================================
// Notification helper
// ============================================================================

async function notify(state: WatcherState, label: string, message: string): Promise<void> {
  await sendNotification({
    message,
    title: `SFPM: ${capitalize(state.jobType)} ${label}`,
  });
}

// ============================================================================
// Utilities
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
