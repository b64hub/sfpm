// ============================================================================
// Contexts
// ============================================================================

/**
 * Fields shared across all local validation capabilities.
 */
export interface BaseValidationContext {
  packageId: string;
  packagePath: string;
  projectRoot: string;
  signal?: AbortSignal;
  timeoutMs?: number;
}

export interface CompileContext extends BaseValidationContext {
  compilePattern?: string;
}

export interface TestContext extends BaseValidationContext {
  testPattern?: string;
}

/**
 * Dependency checking uses only the base context.
 * The implementation holds the ownership index as internal state,
 * built once at construction time.
 */
export type DependencyContext = BaseValidationContext;

// ============================================================================
// Results
// ============================================================================

export interface AvailabilityResult {
  available: boolean;
  compatible?: boolean;
  reason?: string;
  remediation?: string;
  version?: string;
}

export interface Diagnostic {
  column?: number;
  filePath?: string;
  line?: number;
  message: string;
  severity: 'error' | 'info' | 'warning';
}

export interface ValidationResult {
  diagnostics: Diagnostic[];
  durationMs: number;
  raw?: {exitCode: number; stderr: string; stdout: string};
  status: 'error' | 'failed' | 'passed' | 'skipped';
}

export interface BoundaryViolation {
  fromMetadata: string;
  fromPackage: string;
  toMetadata: string;
  toPackage: string;
}

export interface DependencyResult {
  /** Stable caveat codes describing analysis limitations (e.g. 'dynamic-soql-not-read'). */
  caveats: string[];
  durationMs: number;
  status: 'error' | 'failed' | 'passed' | 'skipped';
  /** Dependency targets that could not be attributed to any known package. */
  unresolved: string[];
  violations: BoundaryViolation[];
}

// ============================================================================
// Port
// ============================================================================

/**
 * Pluggable adapter for all local (offline) package validation.
 *
 * Covers three capabilities on a single interface so the orchestrator can
 * make a single availability check and then dispatch to whichever
 * capabilities the current build mode requires.
 *
 * Defined in packages/core as a port; implementations live in packages/validation.
 */
export interface LocalValidator {
  /** Check whether the underlying tool is present and version-compatible. */
  checkAvailability(context: Pick<BaseValidationContext, 'packageId'>): Promise<AvailabilityResult>;
  /** Check for undeclared cross-package dependency boundary violations. */
  checkDependencies(context: DependencyContext): Promise<DependencyResult>;
  /** Compile-check the package's Apex and other compilable metadata. */
  compile(context: CompileContext): Promise<ValidationResult>;
  /** Run the package's test suite. */
  test(context: TestContext): Promise<ValidationResult>;
}
