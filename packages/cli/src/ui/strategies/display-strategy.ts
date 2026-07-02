// ============================================================================
// Display Strategy Interface
// ============================================================================

/**
 * Summary data passed to the strategy on orchestration completion.
 */
export interface CompleteSummary {
  duration: string;
  failed: number;
  packages: PackageResultSummary[];
  skipped: number;
  succeeded: number;
}

export interface PackageResultSummary {
  duration?: string;
  error?: string;
  name: string;
  skipped?: boolean;
  success: boolean;
}

/**
 * Abstraction over how progress output is rendered.
 *
 * Renderers translate domain events into calls on this interface.
 * Each output mode (interactive, plain, json/silent) provides its
 * own implementation.
 *
 * Subtask phases are pre-set and not dynamic:
 *   - `pre-hooks`  — lifecycle hooks before the main action
 *   - (main phase) — build/install/deploy — identified by any other phase string
 *   - `post-hooks` — lifecycle hooks after the main action
 *   - `validation`  — staged validation (optional, build only)
 */
export interface DisplayStrategy {
  // ===========================================================================
  // Orchestration Lifecycle
  // ===========================================================================

  /** Called when orchestration completes (success or mixed). */
  complete(summary: CompleteSummary): void;

  /** Called on an unrecoverable error. */
  error(error: Error): void;

  info(message: string): void;

  /** Called when an orchestration level begins (unlocks packages in that level). */
  levelStart(level: number, packages: string[]): void;

  // ===========================================================================
  // Package-Level
  // ===========================================================================

  packageComplete(packageName: string, duration: string): void;
  packageFail(packageName: string, error?: string): void;
  packageSkip(packageName: string, reason: string): void;
  packageStart(packageName: string): void;

  // ===========================================================================
  // Subtask-Level (within a package)
  // ===========================================================================

  /** Called when orchestration begins. */
  start(title: string, packages: string[], levels?: string[][]): void;
  subtaskComplete(packageName: string, phase: string, detail?: string): void;
  subtaskSkip(packageName: string, phase: string): void;
  subtaskStart(packageName: string, phase: string): void;

  // ===========================================================================
  // Informational
  // ===========================================================================

  subtaskUpdate(packageName: string, phase: string, status: string): void;
  warn(message: string): void;
}
