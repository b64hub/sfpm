// ============================================================================
// Browserforce Hook Options
// ============================================================================

/**
 * A single browserforce plan step defining an org setting to configure.
 *
 * Mirrors the sfdx-browserforce-plugin plan schema.
 *
 * @see https://github.com/amtrack/sfdx-browserforce-plugin
 */
export interface BrowserforcePlanEntry {
  /**
   * The browserforce plugin name (e.g., 'CustomerPortal', 'SecuritySettings').
   */
  name: string;

  /**
   * Key-value settings to apply for this plugin.
   */
  value: Record<string, unknown>;
}

/**
 * Configuration options for the sfdx-browserforce lifecycle hook.
 *
 * Executes browserforce plans against the target org post-deployment,
 * enabling browser-automated configuration of Salesforce settings that
 * are not available via the Metadata or Tooling APIs.
 */
export interface BrowserforceHooksOptions {
  /**
   * Optional filter: only execute for this specific package name.
   * When omitted, the hook runs for all packages.
   */
  packageName?: string;

  /**
   * Inline browserforce plan entries.
   * Mutually exclusive with `planFile`.
   */
  plan?: BrowserforcePlanEntry[];

  /**
   * Path to a browserforce plan JSON file, relative to the project root.
   * Mutually exclusive with `plan`.
   *
   * @example 'config/browserforce-plan.json'
   */
  planFile?: string;
}
