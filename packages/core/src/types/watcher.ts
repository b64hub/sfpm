import type {Connection} from '@salesforce/core';

// ============================================================================
// Job Types
// ============================================================================

/**
 * Supported watcher job types.
 *
 * - `build` — polls Package2VersionCreateRequest for unlocked package builds
 * - `deploy` — polls metadata deploy status
 * - `test`  — polls async Apex test run status
 */
export type WatcherJobType = 'build' | 'deploy' | 'test';

// ============================================================================
// Polling Strategy
// ============================================================================

/**
 * Outcome of a single poll check.
 *
 * Strategies return one of three states:
 * - `pending`   — job is still running, keep polling
 * - `completed` — job finished successfully
 * - `failed`    — job finished with errors
 */
export type PollOutcome<TResult>
  = | {error: string; result: TResult; status: 'failed'}
    | {message?: string; status: 'pending'}
    | {result: TResult; status: 'completed'};

/**
 * Strategy interface for polling a specific Salesforce async job type.
 *
 * Each strategy implements a single-check `poll()` method — the runner
 * owns the loop, interval, timeout, and retry logic.
 *
 * Strategies define sensible defaults for polling interval and timeout
 * that the runner uses unless the caller overrides them.
 */
export interface PollingStrategy<TPayload = unknown, TResult = unknown> {
  /** Create a Salesforce connection from the stored auth info */
  connect(auth: WatcherAuth): Promise<Connection>;
  /** Default polling interval in milliseconds */
  readonly defaultIntervalMs: number;
  /** Default timeout in milliseconds */
  readonly defaultTimeoutMs: number;

  /** Job type identifier */
  readonly jobType: WatcherJobType;

  /** Check the current status of the job. Called once per poll cycle. */
  poll(connection: Connection, payload: TPayload): Promise<PollOutcome<TResult>>;
}

// ============================================================================
// Watcher State
// ============================================================================

/**
 * Authentication context stored in the watcher state file.
 * The strategy is responsible for creating an Org/Connection from this.
 */
export interface WatcherAuth {
  username: string;
}

/**
 * Status of the watcher process.
 */
export type WatcherStatus = 'cancelled' | 'completed' | 'error' | 'polling' | 'starting';

/**
 * Generic watcher state persisted to `.sfpm/watchers/<id>.json`.
 *
 * The envelope carries common metadata (timing, PID, status) while
 * the `payload` and `result` fields are strategy-specific.
 *
 * @typeParam TPayload - Input the polling strategy needs (job IDs, package names, etc.)
 * @typeParam TResult  - Output the polling strategy produces
 */
export interface WatcherState<TPayload = unknown, TResult = unknown> {
  /** Authentication context for Salesforce connection */
  auth: WatcherAuth;
  /** When this watcher was created */
  createdAt: number;
  /** Error message if the watcher failed */
  error?: string;
  /** Polling interval override in milliseconds (uses strategy default if omitted) */
  intervalMs?: number;
  /** Which type of job this watcher is polling */
  jobType: WatcherJobType;
  /** Strategy-specific input data */
  payload: TPayload;
  /** Project directory (for path resolution) */
  projectDir: string;
  /** Strategy-specific result data (populated on completion) */
  result?: TResult;
  /** Timeout in milliseconds (uses strategy default if omitted) */
  timeoutMs?: number;
  /** When the state was last updated */
  updatedAt: number;
  /** PID of the watcher process */
  watcherPid?: number;
  /** Current status of the watcher */
  watcherStatus: WatcherStatus;
}

// ============================================================================
// Strategy-Specific Payloads and Results
// ============================================================================

/**
 * Payload for the `build` job type — polls Package2VersionCreateRequest.
 */
export interface BuildWatcherPayload {
  targets: BuildWatcherTarget[];
}

export interface BuildWatcherTarget {
  packageName: string;
  packageVersionCreateRequestId: string;
  packageVersionId?: string;
}

export interface BuildWatcherResult {
  packages: BuildWatcherPackageResult[];
}

export interface BuildWatcherPackageResult {
  codeCoverage?: number;
  error?: string;
  hasPassedCodeCoverageCheck?: boolean;
  packageName: string;
  packageVersionId?: string;
  status: 'Error' | 'Success' | 'TimedOut';
}

/**
 * Payload for the `deploy` job type — polls metadata deploy status.
 */
export interface DeployWatcherPayload {
  deployId: string;
  packageName?: string;
}

export interface DeployWatcherResult {
  componentErrors?: number;
  componentsDeployed?: number;
  componentsFailed?: number;
  componentTotal?: number;
  error?: string;
  status: string;
  testErrors?: number;
  testsCompleted?: number;
  testsFailed?: number;
  testsTotal?: number;
}

/**
 * Payload for the `test` job type — polls async Apex test run.
 */
export interface ApexTestWatcherPayload {
  testRunId: string;
}

export interface ApexTestWatcherResult {
  classesCompleted?: number;
  classesFailed?: number;
  error?: string;
  methodsFailed?: number;
  methodsPassed?: number;
  status: string;
}
