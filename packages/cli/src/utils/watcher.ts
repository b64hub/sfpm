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
 * Save a watcher state and fork a background process.
 *
 * Two runner scripts are available:
 * - `watcher-runner.js` (default) — generic poll loop for deploy/test jobs.
 *   Resolves a {@link PollingStrategy} by `jobType`, connects, polls in a loop.
 * - `validation-runner.js` — single-pass validation for build jobs.
 *   Runs {@link ValidationResolver.resolve()} directly. Use via
 *   {@link validationRunnerScript}.
 *
 * The child process is detached and unref'd so the parent CLI process
 * can exit immediately.
 */
export async function forkWatcher(state: WatcherState, runnerScript?: string): Promise<ForkWatcherResult> {
  const store = new WatcherStateStore(state.projectDir);
  const id = await store.save(state);
  const stateFilePath = store.getFilePath(id);

  const thisDir = path.dirname(fileURLToPath(import.meta.url));
  const script = runnerScript ?? path.resolve(thisDir, 'watcher-runner.js');

  const child = fork(script, [stateFilePath, id], {
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

/**
 * Resolve the path to the validation-runner.js script (sibling of this file).
 */
export function validationRunnerScript(): string {
  const thisDir = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(thisDir, 'validation-runner.js');
}
