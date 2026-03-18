// ============================================================================
// Flow Activation Hook Options
// ============================================================================

/**
 * Configuration options for the flow activation lifecycle hook.
 *
 * After a package is deployed to a target org, flows included in the
 * deployment may arrive in an inactive state. This hook activates (or
 * deactivates) them to match the intended status declared in the source
 * XML.
 *
 * Flows whose source status is `Active` are activated; flows whose
 * source status is `Draft`, `Obsolete`, or `InvalidDraft` are
 * deactivated.
 */
export interface FlowActivationHooksOptions {
  /**
   * Specific flows to process by developer name (API name).
   * When omitted, all flows included in the package are processed.
   */
  flowNames?: string[];

  /**
   * Skip activation for flows whose latest version is already active.
   * @default true
   */
  skipAlreadyActive?: boolean;
}

// ============================================================================
// Flow Data Types
// ============================================================================

/**
 * A flow extracted from the package source with its intended status.
 */
export interface PackageFlowEntry {
  /** The developer name (API name) of the flow. */
  developerName: string;
  /** The intended status from the source XML (`'Active'`, `'Draft'`, etc.). */
  sourceStatus: string;
}

// ============================================================================
// Tooling API Response Types
// ============================================================================

/**
 * A `FlowDefinition` record returned by the Tooling API.
 *
 * Only the properties the activator reads/writes are declared.
 */
export interface FlowDefinitionRecord {
  ActiveVersion: null | {VersionNumber: number};
  DeveloperName: string;
  Id: string;
  LatestVersion: null | {VersionNumber: number};
  LatestVersionId: null | string;
}
