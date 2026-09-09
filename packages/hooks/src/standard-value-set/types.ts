// ============================================================================
// Standard Value Set Hook Options
// ============================================================================

/**
 * Configuration options for the standard value set patching lifecycle hook.
 *
 * Standard value sets (e.g., Industry, AccountSource) are deployed to
 * the target org via the Metadata API before the package itself, since
 * package version installs do not always apply SVS changes and
 * components that reference SVS values fail if the values are missing.
 *
 * Runs for source and unlocked packages.
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
