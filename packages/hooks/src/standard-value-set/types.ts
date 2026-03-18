// ============================================================================
// Standard Value Set Hook Options
// ============================================================================

/**
 * Configuration options for the standard value set patching lifecycle hook.
 *
 * After a managed or unlocked package version is installed, standard value
 * sets (e.g., Industry, AccountSource) may need to be re-deployed to the
 * target org because package installs do not always apply standard value
 * set changes. This hook patches them as a post-install step.
 */
export interface StandardValueSetHooksOptions {
  /**
   * Path to the directory containing standard value set XML files.
   * When omitted, the hook auto-discovers from the package source structure.
   */
  sourceDirectory?: string;

  /**
   * Specific standard value sets to patch by API name.
   * When omitted, all standard value sets found in the package source are patched.
   *
   * @example ['Industry', 'AccountSource', 'CaseOrigin']
   */
  valueSetNames?: string[];
}
