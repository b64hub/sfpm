
// ============================================================================
// Validation State (build outcome, travels with the artifact)
// ============================================================================

/** Individual validation check that was performed during the build. */
export type ValidationCheck = 'dependencies' | 'deploy' | 'test';

/**
 * Serializable descriptor for a pending (in-flight) validation operation.
 * Written to artifact metadata so cross-process consumers (watcher workflows,
 * subsequent CI steps) can pick up and resolve the validation without the
 * original process being alive.
 */
export interface PendingValidationDescriptor {
  /** The SF operation identifier (deployId for source, PackageVersionCreateRequestId for unlocked) */
  operationId: string;
  /** Which SF API operation to poll for resolution */
  operationType: 'deploy' | 'package-version-request';
  /** Package this validation belongs to */
  packageName: string;
  /** ISO timestamp when the operation was initiated */
  startedAt: string;
  /** The org against which the operation was submitted */
  targetOrg: string;
}

/**
 * Discriminated union describing what validation was performed and its outcome.
 * Set by builders after build/validation completes.
 * Serialized into artifact metadata so downstream processes
 * (install, release) can make decisions based on validation status.
 *
 * Discriminant: `status`
 * - `'pending'` — validation initiated but result not yet known (async build)
 * - `'passed'`  — all validation checks succeeded
 * - `'failed'`  — one or more validation checks failed
 */
export type ValidationState
  = | ValidationStateFailed
    | ValidationStatePassed
    | ValidationStatePending;

export interface ValidationStatePending {
  /** Which validation checks were submitted */
  checks: ValidationCheck[];
  /** Descriptor for the in-flight operation (serializable for cross-process pickup) */
  pending: PendingValidationDescriptor;
  status: 'pending';
}

export interface ValidationStatePassed {
  /** Which validation checks were performed */
  checks: ValidationCheck[];
  /** Number of components successfully deployed */
  componentsDeployed?: number;
  /** Total number of components in the deployment */
  componentsTotal?: number;
  status: 'passed';
  /** Test coverage percentage (0–100), if measured */
  testCoverage?: number;
}

export interface ValidationStateFailed {
  /** Which validation checks were attempted */
  checks: ValidationCheck[];
  /** Number of components successfully deployed */
  componentsDeployed?: number;
  /** Total number of components in the deployment */
  componentsTotal?: number;
  /** Human-readable error description */
  error?: string;
  status: 'failed';
  /** Test coverage percentage (0–100), if measured */
  testCoverage?: number;
}
