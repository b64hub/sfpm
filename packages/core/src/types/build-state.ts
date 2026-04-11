// ============================================================================
// Local Build State Types
// ============================================================================

/**
 * Per-package validation state persisted to the local filesystem.
 *
 * Used by the CLI watcher to poll Salesforce for async validation
 * completion after `sfpm build --async-validation`.
 */
export interface LocalPackageBuildState {
  /** Package name */
  packageName: string;
  /** Package type (Unlocked, Source, Data) */
  packageType: string;
  /** Package2VersionCreateRequest ID — used to poll async validation status */
  packageVersionCreateRequestId?: string;
  /** Subscriber package version ID (04t...) */
  packageVersionId?: string;
  /** Resolved version number (e.g., 1.0.0-1) */
  version?: string;
}

/**
 * Status of the async validation watcher process.
 */
export type WatcherStatus = 'completed' | 'error' | 'polling' | 'starting';

/**
 * Full build state persisted to `<projectDir>/.sfpm/async-builds/<id>.json`.
 *
 * Written by the `build` command when `--async-validation` is used,
 * read by the watcher process and by `build:status`.
 */
export interface LocalBuildState {
  /** When this state was created */
  createdAt: number;
  /** DevHub username used for unlocked package builds */
  devhubUsername: string;
  /** Per-package build outcomes pending validation */
  packages: LocalPackageBuildState[];
  /** Project directory */
  projectDir: string;
  /** Validation results populated by the watcher */
  results?: LocalValidationResult[];
  /** When the state was last updated */
  updatedAt: number;
  /** Timeout for the watcher in milliseconds */
  waitTimeMs: number;
  /** PID of the watcher process (set after fork) */
  watcherPid?: number;
  /** Current status of the watcher */
  watcherStatus: WatcherStatus;
}

/**
 * Per-package validation result written by the watcher.
 */
export interface LocalValidationResult {
  codeCoverage?: number;
  error?: string;
  hasPassedCodeCoverageCheck?: boolean;
  packageName: string;
  packageVersionId?: string;
  status: 'Error' | 'Success' | 'TimedOut';
}
