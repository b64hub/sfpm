// ============================================================================
// Standard Value Set Hook Options
// ============================================================================

/**
 * Configuration options for the standard value set patching lifecycle hook.
 *
 * After an unlocked package version is installed, standard value sets
 * (e.g., Industry, AccountSource) may need to be re-deployed to the
 * target org because version installs do not always apply standard value
 * set changes. This hook performs a Metadata API deploy of the SVS files
 * as a post-install step.
 *
 * Only runs for unlocked packages — source packages are deployed
 * directly and don't need this fixup.
 */
export interface StandardValueSetHooksOptions {
  /**
   * Specific standard value sets to patch by API name.
   * When omitted, all standard value sets found in the package source
   * are deployed.
   *
   * @example ['Industry', 'AccountSource', 'CaseOrigin']
   */
  valueSetNames?: string[];
}

// ============================================================================
// Deploy Result
// ============================================================================

/**
 * Simplified result returned by the SVS deployer.
 */
export interface StandardValueSetDeployResult {
  /** Number of components successfully deployed. */
  componentsDeployed: number;
  /** Total number of components in the deploy. */
  componentsTotal: number;
  /** Whether the deployment succeeded. */
  success: boolean;
}
