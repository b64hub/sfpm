import fs from 'node:fs';
import path from 'node:path';

import type {LocalBuildState} from '../types/build-state.js';

// ============================================================================
// Constants
// ============================================================================

const ASYNC_BUILDS_DIR = '.sfpm/async-builds';

// ============================================================================
// BuildStateStore
// ============================================================================

/**
 * Reads and writes local build state files for async validation watchers.
 *
 * State files live at `<projectDir>/.sfpm/async-builds/<id>.json`.
 * Each async build creates a new state file. The watcher updates
 * it with results when validation completes.
 *
 * @example
 * ```typescript
 * const store = new BuildStateStore(projectDir);
 * const id = await store.save(state);
 * const restored = await store.load(id);
 * ```
 */
export class BuildStateStore {
  private readonly dir: string;

  constructor(projectDir: string) {
    this.dir = path.join(projectDir, ASYNC_BUILDS_DIR);
  }

  /**
   * Get the absolute file path for a given state ID.
   */
  getFilePath(id: string): string {
    return this.filePath(id);
  }

  /**
   * List all state files with their IDs and parsed state.
   */
  async list(): Promise<Array<{id: string; state: LocalBuildState}>> {
    if (!fs.existsSync(this.dir)) return [];

    const files = await fs.promises.readdir(this.dir);
    const entries: Array<{id: string; state: LocalBuildState}> = [];

    for (const file of files) {
      if (!file.endsWith('.json')) continue;
      const id = file.replace(/\.json$/, '');
      const state = await this.load(id); // eslint-disable-line no-await-in-loop
      if (state) entries.push({id, state});
    }

    return entries.sort((a, b) => b.state.createdAt - a.state.createdAt);
  }

  /**
   * Load a build state by ID. Returns null if not found or invalid.
   */
  async load(id: string): Promise<LocalBuildState | null> {
    const filePath = this.filePath(id);
    if (!fs.existsSync(filePath)) return null;

    try {
      const raw = await fs.promises.readFile(filePath, 'utf8');
      return JSON.parse(raw) as LocalBuildState;
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
   * Remove all state files whose watcher process is no longer running
   * or whose status is 'completed' or 'error'.
   */
  async removeStale(): Promise<number> {
    const entries = await this.list();
    let removed = 0;

    for (const entry of entries) {
      const isTerminal = entry.state.watcherStatus === 'completed' || entry.state.watcherStatus === 'error';
      const isOrphan = entry.state.watcherPid ? !isProcessRunning(entry.state.watcherPid) : true;

      if (isTerminal || isOrphan) {
        await this.remove(entry.id); // eslint-disable-line no-await-in-loop
        removed++;
      }
    }

    return removed;
  }

  /**
   * Save a build state and return a unique ID for it.
   */
  async save(state: LocalBuildState): Promise<string> {
    await fs.promises.mkdir(this.dir, {recursive: true});
    const id = `${Date.now()}-${randomSuffix()}`;
    const filePath = this.filePath(id);
    await fs.promises.writeFile(filePath, JSON.stringify(state, null, 2), 'utf8');
    return id;
  }

  /**
   * Update an existing state file (e.g., to set watcherPid or results).
   */
  async update(id: string, state: LocalBuildState): Promise<void> {
    const filePath = this.filePath(id);
    state.updatedAt = Date.now();
    await fs.promises.writeFile(filePath, JSON.stringify(state, null, 2), 'utf8');
  }

  private filePath(id: string): string {
    // Prevent path traversal
    const sanitized = path.basename(id);
    return path.join(this.dir, `${sanitized}.json`);
  }
}

// ============================================================================
// Helpers
// ============================================================================

function randomSuffix(): string {
  return Math.random().toString(36).slice(2, 8);
}

/**
 * Check if a process with the given PID is still running.
 */
function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
