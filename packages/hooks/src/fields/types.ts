// ============================================================================
// Field Tracking Type
// ============================================================================

/**
 * The type of field tracking to enable.
 * - `'history'` — Field History Tracking (`trackHistory`)
 * - `'feed'` — Feed Tracking (`trackFeedHistory`)
 */
export type FieldTrackingType = 'feed' | 'history';

// ============================================================================
// Hook Options
// ============================================================================

/**
 * Configuration options for the field history tracking hook.
 */
export interface FieldHistoryTrackingHooksOptions {
  /**
   * Skip scratch orgs. Field history tracking behaves differently in
   * scratch orgs and enabling it can cause deployment errors.
   *
   * @default true
   */
  skipScratchOrgs?: boolean;
}

/**
 * Configuration options for the feed tracking hook.
 */
export interface FeedTrackingHooksOptions {
  /**
   * Skip scratch orgs. Feed tracking behaves differently in scratch orgs
   * and enabling it can cause deployment errors.
   *
   * @default true
   */
  skipScratchOrgs?: boolean;
}

// ============================================================================
// Result
// ============================================================================

/**
 * Result of a field tracking enablement operation.
 */
export interface FieldTrackingResult {
  /** Number of fields whose tracking was newly enabled. */
  fieldsEnabled: number;
  /** Number of fields that already had tracking enabled (skipped). */
  fieldsSkipped: number;
  /** Whether the operation completed successfully. */
  success: boolean;
}
