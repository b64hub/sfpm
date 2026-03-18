// ============================================================================
// Picklist Hook Options
// ============================================================================

/**
 * Configuration options for the picklist enablement lifecycle hook.
 *
 * After a package is deployed, custom picklist values may not be active
 * in the target org. This hook enables deployed picklist values as a
 * post-install step.
 */
export interface PicklistHooksOptions {
  /**
   * Whether to activate only newly-added values or all deployed values.
   * - `'new'`  — only activate values that did not previously exist (default)
   * - `'all'`  — activate all deployed values regardless of prior state
   *
   * @default 'new'
   */
  activationStrategy?: 'all' | 'new';

  /**
   * Specific picklist fields to target, as `Object.Field` API names.
   * When omitted, all picklist fields included in the package are processed.
   *
   * @example ['Account.Industry', 'Case.Priority']
   */
  fieldNames?: string[];
}
