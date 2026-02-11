// ============================================================================
// Shared Types & Utilities for Progress Renderers
// ============================================================================

/**
 * Output modes for progress rendering.
 *
 * - `interactive` — Full UI with spinners, colors, boxes
 * - `quiet`       — Only errors and final results
 * - `json`        — Structured JSON output for CI/CD
 */
export type OutputMode = 'interactive' | 'json' | 'quiet';

/**
 * Logger interface for rendering output.
 */
export interface OutputLogger {
  error: (message: Error | string) => void;
  log: (message: string) => void;
}

/**
 * Collected event data for JSON output.
 */
export interface EventLog {
  data: any;
  timestamp: Date;
  type: string;
}

/**
 * Event handler function type.
 */
export type EventHandler<T = any> = (event: T) => void;

/**
 * Event configuration for systematic handling.
 */
export interface EventConfig {
  description: string;
  handler: EventHandler;
}

// ============================================================================
// Duration Formatting
// ============================================================================

/**
 * Format a duration in milliseconds to a human-readable string.
 *
 * - < 1 s  → `"420ms"`
 * - < 60 s → `"3.2s"`
 * - ≥ 60 s → `"2m 15s"`
 */
export function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.floor((ms % 60_000) / 1000);
  return `${minutes}m ${seconds}s`;
}

/**
 * Calculate the human-readable duration between a start date and an end date.
 * Returns an empty string when `start` is undefined.
 */
export function calculateDuration(start: Date | undefined, end: Date): string {
  if (!start) return '';
  return formatDuration(end.getTime() - start.getTime());
}

// ============================================================================
// Name Alignment
// ============================================================================

/**
 * Tracks a set of unique names and computes the maximum length
 * so they can be right-padded for columnar alignment.
 *
 * ```ts
 * const aligner = new NameAligner();
 * aligner.add('Apex');
 * aligner.add('CustomLabels');
 * aligner.pad('Apex');       // 'Apex        '
 * ```
 */
export class NameAligner {
  private maxLength = 0;
  private names = new Set<string>();

  /** Register a name. Updates the max width when it grows. */
  add(name: string): void {
    if (!this.names.has(name)) {
      this.names.add(name);
      this.maxLength = Math.max(this.maxLength, name.length);
    }
  }

  /** Right-pad `name` to the current max width. */
  pad(name: string): string {
    return name.padEnd(this.maxLength);
  }

  /** Clear tracked names and reset the max width. */
  reset(): void {
    this.names.clear();
    this.maxLength = 0;
  }
}
