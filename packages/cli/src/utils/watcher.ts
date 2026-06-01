import type {WatcherState} from '@b64hub/sfpm-core';

import {WatcherStateStore} from '@b64hub/sfpm-core';
/**
 * Generic watcher utilities for async Salesforce job polling.
 *
 * Provides `forkWatcher()` — saves a `WatcherState` file and forks
 * the generic `watcher-runner.js` script as a detached background process.
 */
import {fork} from 'node:child_process';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

// ============================================================================
// Types
// ============================================================================

export interface ForkWatcherResult {
  /** Generated watcher ID */
  id: string;
  /** PID of the forked watcher process */
  pid: number | undefined;
  /** Absolute path to the state file */
  stateFilePath: string;
}

// ============================================================================
// forkWatcher
// ============================================================================

/**
 * Save a watcher state and fork a background polling process.
 *
 * The forked process runs `watcher-runner.js` — a generic script that:
 * 1. Loads the state file
 * 2. Resolves the polling strategy from the strategy registry
 * 3. Connects to Salesforce
 * 4. Polls in a loop with retry/backoff
 * 5. Updates the state file with results
 * 6. Sends a desktop notification
 *
 * The child process is detached and unref'd so the parent CLI process
 * can exit immediately.
 */
export async function forkWatcher(state: WatcherState): Promise<ForkWatcherResult> {
  const store = new WatcherStateStore(state.projectDir);
  const id = await store.save(state);
  const stateFilePath = store.getFilePath(id);

  const thisDir = path.dirname(fileURLToPath(import.meta.url));
  const runnerScript = path.resolve(thisDir, 'watcher-runner.js');

  const child = fork(runnerScript, [stateFilePath, id], {
    detached: true,
    stdio: 'ignore',
  });

  child.unref();

  // Update state with the watcher PID
  state.watcherPid = child.pid;
  state.watcherStatus = 'polling';
  await store.update(id, state);

  return {id, pid: child.pid, stateFilePath};
}
