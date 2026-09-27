/** Small filesystem helpers shared by the release build and smoke test scripts. */
import {
  existsSync, readdirSync, readFileSync, statSync,
} from 'node:fs';
import {join} from 'node:path';

/**
 * Reads a file as utf8, or returns `null` if it doesn't exist. Unlike a bare
 * `try { readFileSync } catch { return null }`, a permission error or an
 * `EISDIR` still throws — only "the file isn't there" is treated as absence.
 */
export function readTextIfExists(path) {
  if (!existsSync(path)) return null;
  return readFileSync(path, 'utf8');
}

/** Recursively sums file sizes under `dir`. Cross-platform alternative to shelling out to `du`. */
export function dirSize(dir) {
  let total = 0;
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const stat = statSync(full);
    total += stat.isDirectory() ? dirSize(full) : stat.size;
  }

  return total;
}

/** Formats a byte count as e.g. `"12.3MB"`. */
export function formatBytes(bytes) {
  const units = ['B', 'KB', 'MB', 'GB'];
  let size = bytes;
  let unitIndex = 0;
  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024;
    unitIndex += 1;
  }

  return `${size.toFixed(1)}${units[unitIndex]}`;
}
