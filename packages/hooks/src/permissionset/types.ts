// ============================================================================
// Permission Set Assignment Hook Options
// ============================================================================

/**
 * Configuration options for the permission set assignment lifecycle hook.
 *
 * Assigns permission sets to the target org user before and/or after
 * package installation. Permission set names can be provided globally
 * via {@link permSets}, and/or per-package via
 * `packageOptions.hooks["permission-set"].pre/post` in `sfdx-project.json`.
 */
export interface PermissionSetHooksOptions {
  /**
   * Whether to abort the pipeline if any assignment fails.
   * When `false`, failures are logged as warnings.
   * @default false
   */
  failOnError?: boolean;

  /**
   * Explicit permission set API names to assign. When provided, these
   * are assigned **in addition to** any names from the package definition.
   */
  permSets?: string[];
}

/**
 * Result of a single permission set assignment attempt.
 */
export interface PermSetAssignmentEntry {
  /** Error message when status is `'failed'`. */
  message?: string;
  /** The permission set API name. */
  name: string;
  /** Outcome of the assignment attempt. */
  status: 'assigned' | 'failed' | 'skipped';
}

/**
 * Aggregated results of a batch permission set assignment.
 */
export interface PermSetAssignmentResult {
  /** Permission sets that were successfully assigned. */
  assigned: string[];
  /** Permission sets that could not be assigned, with error details. */
  failed: Array<{message: string; name: string}>;
  /** Permission sets already assigned to the user (no-op). */
  skipped: string[];
}
