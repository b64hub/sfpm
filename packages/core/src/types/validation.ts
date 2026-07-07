import {TestLevel} from './package.js';

/**
 * Validation level for builds.
 *
 * - `none`  — assemble only, no analysis, no org interaction
 * - `local` — static analysis only (dependency checks), no org
 * - `org`   — org validation only (deploy+test for source, SF API for unlocked)
 * - `full`  — static analysis + org validation (default)
 */
export type ValidationLevel = 'full' | 'local' | 'none' | 'org';

/** Individual validation check that was performed during the build. */
export type ValidationCheck = 'dependencies' | 'deploy' | 'test';

export interface PackageVersionValidationDescriptor {
  devhub: string;
  operationType: 'package-version-request';
  packageName: string;
  packageVersionRequestId: string;
  startedAt?: string;
}

export interface DeployValidationDescriptor {
  operationType: 'deploy';
  packageName: string;
  targetOrg: string;
  testLevel: TestLevel
}

/**
 * Serializable descriptor for a pending (in-flight) validation operation.
 * Written to artifact metadata so cross-process consumers (watcher workflows,
 * subsequent CI steps) can pick up and resolve the validation without the
 * original process being alive.
 */
export type PendingValidationDescriptor = DeployValidationDescriptor | PackageVersionValidationDescriptor;

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
