import {Logger} from '../../../../types/logger.js';
import {SfpmMetadataPackage} from '../../../sfpm-package.js';

/** A component that failed during deployment. */
export interface ComponentError {
  fullName: string;
  problem: string;
}

/** Deployment result — only present when the strategy deploys metadata. */
export interface ComponentResult {
  deployed: number;
  errors: ComponentError[];
  success: boolean;
  total: number;
}

/** Per-method test result with optional timing. */
export interface TestMethodResult {
  durationMs?: number;
  message?: string;
  methodName: string;
  outcome: 'fail' | 'pass' | 'skip';
  stackTrace?: string;
}

/** Coverage data for a single class or trigger. */
export interface ClassCoverage {
  totalLines: number;
  uncoveredLines: number;
}

/** Per-class test result grouping methods and coverage. */
export interface TestClassResult {
  className: string;
  /** Coverage for this class. Undefined for test classes (they don't produce coverage). */
  coverage?: ClassCoverage;
  methods: TestMethodResult[];
}

/** Aggregate test results. */
export interface TestResult {
  failed: number;
  passed: number;
  results: TestClassResult[];
  total: number;
}

/**
 * Rich outcome returned by {@link ValidationStrategy.pollResult}.
 *
 * Strategies populate what their API provides:
 * - Deploy mode: `deployment` + `tests` (with per-class coverage)
 * - Test-only mode: `tests` (with per-class coverage)
 *
 * The task inspects presence/absence to decide which assertions to run.
 */
export interface ValidationResult {
  /** Deployment result. Undefined in test-only mode (no deployment occurs). */
  deployment?: ComponentResult;
  /** Test results — always present. Includes per-class coverage when available. */
  tests: TestResult;
}

// ==========================================================================
// Strategy context and interface
// ==========================================================================

/**
 * Shared context passed to all validation strategies.
 */
export interface ValidationContext {
  logger?: Logger;
  sfpmPackage: SfpmMetadataPackage;
  validationOrg: string;
}

/**
 * Progress snapshot emitted on each polling iteration.
 * Consumers (CLI spinners, Actions log groups) use this for heartbeat updates.
 */
export interface ValidationProgress {
  /** Current polling attempt (1-based). */
  attempt: number;
  /** Human-readable status message. */
  message: string;
  /** Completion percentage (0–100), when available. */
  percentage?: number;
  /** Raw Salesforce job status string. */
  status: string;
}

/** Options for {@link ValidationStrategy.pollResult}. */
export interface PollOptions {
  /** Called on each polling iteration with a progress snapshot. */
  onProgress?: (progress: ValidationProgress) => void;
}

/**
 * Strategy interface for validation execution paths.
 *
 * Each implementation handles one validation mode (deploy+test or test-only).
 * Strategies are pure "fetch and normalize" — they poll the SF API, parse the
 * response into a {@link ValidationResult}, and return it. All assertions
 * and business logic live in the task.
 */
export interface ValidationStrategy {
  /** Which execution path this strategy represents. */
  readonly mode: 'deploy' | 'test-only';

  /**
   * Start the validation.
   */
  validate(testClasses: string[], options?: PollOptions): Promise<ValidationResult>;
}
