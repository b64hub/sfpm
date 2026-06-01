import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import type {WatcherJobType, WatcherState} from '../types/watcher.js';

// ============================================================================
// Constants
// ============================================================================

const WATCHERS_DIR = '.sfpm/watchers';

// ============================================================================
// WatcherStateStore
// ============================================================================

/**
 * Reads and writes watcher state files for async polling jobs.
 *
 * State files live at `<projectDir>/.sfpm/watchers/<id>.json`.
 * Each async job creates a state file. The watcher runner updates
 * it with results when polling completes.
 */
export class WatcherStateStore {
  private readonly dir: string;

  constructor(projectDir: string) {
    this.dir = path.join(projectDir, WATCHERS_DIR);
  }

  /**
   * Get the absolute file path for a given watcher ID.
   */
  getFilePath(id: string): string {
    return this.filePath(id);
  }

  /**
   * List all state files, optionally filtered by job type.
   */
  async list(jobType?: WatcherJobType): Promise<Array<{id: string; state: WatcherState}>> {
    if (!fs.existsSync(this.dir)) return [];

    const files = await fs.promises.readdir(this.dir);
    const entries: Array<{id: string; state: WatcherState}> = [];

    for (const file of files) {
      if (!file.endsWith('.json')) continue;
      const id = file.replace(/\.json$/, '');
      const state = await this.load(id); // eslint-disable-line no-await-in-loop
      if (state && (!jobType || state.jobType === jobType)) {
        entries.push({id, state});
      }
    }

    return entries.sort((a, b) => b.state.createdAt - a.state.createdAt);
  }

  /**
   * Load a watcher state by ID. Returns null if not found or invalid.
   */
  async load(id: string): Promise<null | WatcherState> {
    const filePath = this.filePath(id);
    if (!fs.existsSync(filePath)) return null;

    try {
      const raw = await fs.promises.readFile(filePath, 'utf8');
      return JSON.parse(raw) as WatcherState;
    } catch {
      return null;
    }
  }

  /**
   * Remove a state file by ID.
   */
  async remove(id: string): Promise<void> {
    const filePath = this.filePath(id);
    if (fs.existsSync(filePath)) {
      await fs.promises.unlink(filePath);
    }
  }

  /**
   * Remove state files whose watcher process is no longer running
   * or whose status is terminal (`completed`, `error`, `cancelled`).
   */
  async removeStale(jobType?: WatcherJobType): Promise<number> {
    const entries = await this.list(jobType);
    let removed = 0;

    for (const entry of entries) {
      const isTerminal
        = entry.state.watcherStatus === 'completed'
          || entry.state.watcherStatus === 'error'
          || entry.state.watcherStatus === 'cancelled';
      const isOrphan = entry.state.watcherPid ? !isProcessRunning(entry.state.watcherPid) : true;

      if (isTerminal || isOrphan) {
        await this.remove(entry.id); // eslint-disable-line no-await-in-loop
        removed++;
      }
    }

    return removed;
  }

  /**
   * Save a watcher state and return a unique ID for it.
   */
  async save(state: WatcherState): Promise<string> {
    await fs.promises.mkdir(this.dir, {recursive: true});
    const id = crypto.randomUUID();
    const filePath = this.filePath(id);
    await fs.promises.writeFile(filePath, JSON.stringify(state, null, 2), 'utf8');
    return id;
  }

  /**
   * Update an existing state file.
   */
  async update(id: string, state: WatcherState): Promise<void> {
    const filePath = this.filePath(id);
    state.updatedAt = Date.now();
    await fs.promises.writeFile(filePath, JSON.stringify(state, null, 2), 'utf8');
  }

  private filePath(id: string): string {
    const sanitized = path.basename(id);
    return path.join(this.dir, `${sanitized}.json`);
  }
}

// ============================================================================
// Helpers
// ============================================================================

function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
