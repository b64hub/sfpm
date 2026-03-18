// ============================================================================
// Flow Activation Hook Options
// ============================================================================

/**
 * Configuration options for the flow activation lifecycle hook.
 *
 * After a package is deployed to a target org, any flows that were included
 * in the deployment may arrive in an inactive state. This hook activates
 * them as a post-install step.
 */
export interface FlowActivationHooksOptions {
  /**
   * Specific flows to activate by API name.
   * When omitted, all flows included in the package are activated.
   */
  flowNames?: string[];

  /**
   * Skip activation for flows that are already active.
   * @default true
   */
  skipAlreadyActive?: boolean;

  /**
   * Only activate flows matching this version status.
   * - `'latest'` — activate only the latest version of each flow (default)
   * - `'all'`    — activate all deployed versions
   *
   * @default 'latest'
   */
  versionStrategy?: 'all' | 'latest';
}
