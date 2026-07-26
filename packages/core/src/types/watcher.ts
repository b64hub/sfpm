import type {Connection} from '@salesforce/core';

import type {PendingValidationDescriptor} from './validation.js';

// ============================================================================
// Job Types
// ============================================================================

/**
 * Supported watcher job types.
 *
 * - `build`  — runs validation resolver: deploy orchestration + package version polling
 * - `deploy` — polls a single metadata deploy status
 * - `test`   — polls a single async Apex test run status
 *
 * The `build` job type uses {@link ValidationResolver} directly (via `validation-runner`)
 * rather than the poll-loop watcher. Deploy and test jobs use polling strategies
 * via `watcher-runner`.
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
 * the `payload` and `result` fields are job-specific.
 *
 * Two execution models use this state:
 *
 * **Poll-loop** (`watcher-runner`) — for `deploy` and `test` jobs.
 *   Resolves a {@link PollingStrategy} by `jobType`, calls `strategy.poll()`
 *   in a loop until completion, timeout, or fatal error.
 *
 * **Single-pass** (`validation-runner`) — for `build` jobs.
 *   Reconstructs {@link ProjectService} from `projectDir`, runs
 *   {@link ValidationResolver.resolve()} with the full
 *   {@link PendingValidationDescriptor} array from the payload.
 *   Handles both deploy orchestration and package-version polling
 *   in a single pass — no poll loop needed.
 *
 * Both runners update the state file with results and send a desktop
 * notification on completion.
 *
 * @typeParam TPayload - Job-specific input (e.g. {@link BuildWatcherPayload})
 * @typeParam TResult  - Job-specific output written on completion
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
  /** Which type of job this watcher runs — determines the runner and execution model */
  jobType: WatcherJobType;
  /** Job-specific input data */
  payload: TPayload;
  /** Project directory — runners use this to reconstruct ProjectService */
  projectDir: string;
  /** Job-specific result data (populated on completion) */
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
 * Payload for the `build` job type.
 *
 * Carries the full validation descriptors so both package-version-request
 * polling and deploy validation (via InstallOrchestrator) can run from
 * a background watcher process.
 */
export interface BuildWatcherPayload {
  /** Auto-created scratch org to delete after validation completes */
  cleanupBuildOrg?: {devhubUsername: string; username: string};
  /** Full validation descriptors (deploy + package-version-request) */
  validations: PendingValidationDescriptor[];
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
