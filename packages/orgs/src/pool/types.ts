import type {Logger} from '@b64/sfpm-core';

import type {ScratchOrg} from '../org/scratch/types.js';
import type {AllocationStatus, ScratchOrgDefaults} from '../org/types.js';

// ============================================================================
// Pool Configuration
// ============================================================================

/**
 * Pool sizing configuration — how many scratch orgs to maintain.
 *
 * `minAllocation` and `maxAllocation` define the target range.
 * The pool manager ensures the pool stays within these bounds.
 */
export interface PoolSizingConfig {
  /** Number of orgs to create per provisioning batch (default: 5) */
  batchSize?: number;
  /** Maximum number of scratch orgs in the pool */
  maxAllocation: number;
  /** Minimum number of scratch orgs to maintain (default: 0) */
  minAllocation?: number;
}

/**
 * Full pool configuration.
 *
 * Sub-configs for deployment, network, artifacts, and scripts are
 * inlined for simplicity — they are only referenced here.
 *
 * @example
 * ```typescript
 * const pool: PoolConfig = {
 *   tag: 'dev-pool',
 *   scratchOrg: {
 *     definitionFile: 'config/project-scratch-def.json',
 *     expiryDays: 7,
 *   },
 *   sizing: {
 *     maxAllocation: 10,
 *     minAllocation: 2,
 *     batchSize: 5,
 *   },
 * };
 * ```
 */
export interface PoolConfig {
  /** Deployment behavior for freshly provisioned orgs */
  deployment?: {
    /** Disable source package override during deployment (default: false) */
    disableSourcePackageOverride?: boolean;
    /** Whether to enable source tracking in the org (default: false) */
    enableSourceTracking?: boolean;
    /** Whether to install all packages or only changed ones (default: false) */
    installAll?: boolean;
    /** Encryption keys for protected packages (comma-separated) */
    keys?: string;
    /** Continue pool provisioning even if deployment fails (default: false) */
    succeedOnDeploymentErrors?: boolean;
  };

  /** Enable Vlocity/OmniStudio support (default: false) */
  enableVlocity?: boolean;

  /** Artifact fetching configuration */
  fetchArtifacts?: {
    /** Path to a custom script that fetches artifacts */
    artifactFetchScript?: string;
    /** Fetch artifacts from an npm registry */
    npm?: {
      /** Path to `.npmrc` for authentication */
      npmrcPath?: string;
      /** npm scope to fetch from (e.g., `@myorg`) */
      scope: string;
    };
  };

  /** Network/IP relaxation settings */
  network?: {
    /** Specific IP ranges to relax (only used if `relaxAllIPRanges` is false) */
    ipRangesToBeRelaxed?: string[];
    /** Relax all IP range restrictions (default: false) */
    relaxAllIPRanges?: boolean;
  };

  /** Release config file for pool-based releases */
  releaseConfigFile?: string;

  /** Retry the full provisioning flow on failure (default: false) */
  retryOnFailure?: boolean;

  /** Scratch org creation defaults */
  scratchOrg: ScratchOrgDefaults;

  /** Legacy script hooks (prefer sfpm.config.ts hooks instead) */
  scripts?: {
    /** Script to run after package deployment into the scratch org */
    postDeploymentScriptPath?: string;
    /** Script to run before dependency installation */
    preDependencyInstallationScriptPath?: string;
  };

  /** Pool sizing constraints */
  sizing: PoolSizingConfig;

  /** Use an existing snapshot pool as a base (pool tag) */
  snapshotPool?: string;

  /** Tag identifying this pool (used for claiming/releasing orgs) */
  tag: string;
}

/** Default pool sizing when not explicitly configured. */
export const DEFAULT_POOL_SIZING: Required<Pick<PoolSizingConfig, 'batchSize' | 'minAllocation'>> = {
  batchSize: 5,
  minAllocation: 0,
};

// ============================================================================
// Pool Infrastructure
// ============================================================================

/**
 * Record shape for updating scratch org pool metadata in the DevHub.
 */
export interface PoolOrgRecord {
  allocationStatus: AllocationStatus;
  id: string;
  password?: string;
  poolTag: string;
}

/**
 * Unified provider for pool scratch org operations.
 *
 * Combines org retrieval, pool state queries, and prerequisite validation
 * into a single interface. These are always co-implemented (by `DevHubService`)
 * since they all query the same `ScratchOrgInfo` sobject.
 *
 * At the CLI layer, this is implemented by `DevHubService`.
 */
export interface PoolOrgProvider {
  /**
   * Claim a scratch org for use (optimistic concurrency).
   *
   * Sets the org's allocation status to `'Allocate'`. Returns `true`
   * if the claim succeeded, `false` if another consumer claimed it first.
   */
  claimOrg(id: string): Promise<boolean>;

  /** Count active scratch orgs with a given pool tag */
  getActiveCountByTag(tag: string): Promise<number>;

  /**
   * Query available scratch orgs in a pool.
   *
   * @param tag - Pool tag to filter by
   * @param myPool - When true, only return orgs created by the current user
   * @returns Available scratch orgs with metadata populated
   */
  getAvailableByTag(tag: string, myPool?: boolean): Promise<ScratchOrg[]>;

  /**
   * Query all scratch orgs in a pool regardless of status.
   *
   * Returns orgs with all allocation statuses (Available, In Progress,
   * Assigned, etc.). Used by pool deletion to find orgs to remove.
   * Each returned org should include its `recordId` (the ActiveScratchOrg ID)
   * when the org is still active.
   *
   * @param tag - Pool tag to filter by
   * @param myPool - When true, only return orgs created by the current user
   * @returns All pool orgs with metadata populated
   */
  getOrgsByTag(tag: string, myPool?: boolean): Promise<ScratchOrg[]>;

  /** Fetch the DevHub record IDs for a list of scratch orgs (by orgId) */
  getRecordIds(scratchOrgs: ScratchOrg[]): Promise<ScratchOrg[]>;

  /** Get the remaining scratch org capacity on the DevHub */
  getRemainingCapacity(): Promise<number>;

  /** Check if a scratch org is still active (not deleted) */
  isOrgActive(username: string): Promise<boolean>;

  /** Update scratch org pool metadata (tag, status, auth info) */
  updatePoolMetadata(records: PoolOrgRecord[]): Promise<void>;

  /** Validate DevHub prerequisites (custom fields, picklist values). Throws `OrgError` if not met. */
  validate(): Promise<void>;
}

// ============================================================================
// Pool Authentication
// ============================================================================

/**
 * Handles JWT authentication to scratch orgs fetched from a pool.
 *
 * Scratch orgs inherit the DevHub's Connected App credentials
 * automatically via the `parentUsername` mechanism. The authenticator
 * calls `AuthInfo.create()` with `parentUsername` and JWT
 * `oauth2Options` to establish a local auth session.
 *
 * Implement at the CLI layer where `@salesforce/core` is available.
 * The adapter is provided via DI to `PoolFetcher`.
 */
export interface PoolOrgAuthenticator {
  /** Enable source tracking for a claimed scratch org */
  enableSourceTracking?(scratchOrg: ScratchOrg): Promise<void>;

  /** Whether the org has valid authentication credentials */
  hasValidAuth(scratchOrg: ScratchOrg): boolean;

  /** Authenticate to a scratch org via JWT. */
  login(scratchOrg: ScratchOrg): Promise<void>;
}

// ============================================================================
// Pool Fetching
// ============================================================================

/**
 * Action to execute after a scratch org has been claimed from the pool.
 *
 * Injected into `PoolFetcher` to handle post-claim side effects like
 * sharing the org via email. This decouples the fetcher from `OrgService`
 * and keeps it focused on claim-and-authenticate logic.
 *
 * @param org - The claimed scratch org
 * @param options - The original fetch options (includes `sendToUser`, etc.)
 */
export type PostClaimAction = (org: ScratchOrg, options: PoolFetchOptions) => Promise<void>;

/**
 * Options for fetching scratch orgs from a pool.
 *
 * Used for both single-org fetch (claims via optimistic concurrency)
 * and multi-org fetch (no claiming — caller manages allocation).
 */
export interface PoolFetchOptions {
  /** Enable source tracking after fetching */
  enableSourceTracking?: boolean;
  /** Maximum number of orgs to fetch (only used with fetchAll) */
  limit?: number;
  /** Only return orgs owned by the current user */
  myPool?: boolean;
  /**
   * Optional callback invoked after an org is claimed (single-fetch only).
   * Use for side effects like sharing the org via email.
   */
  postClaimAction?: PostClaimAction;
  /**
   * Only return orgs with valid authentication credentials.
   *
   * When true, candidates are filtered through
   * `PoolOrgAuthenticator.hasValidAuth()` — typically checking
   * that the org has a `username` and `loginUrl` for JWT auth.
   */
  requireValidAuth?: boolean;
  /** Email address to send the org details to instead of logging in locally */
  sendToUser?: string;
  /** Pool tag to fetch from */
  tag: string;
}

// ============================================================================
// Pool Deletion
// ============================================================================

/**
 * Options for deleting scratch orgs from a pool.
 */
export interface PoolDeleteOptions {
  /** Only delete orgs with 'In Progress' allocation status */
  inProgressOnly?: boolean;
  /** Only delete orgs owned by the current user */
  myPool?: boolean;
  /** Pool tag identifying which pool to delete from */
  tag: string;
}

// ============================================================================
// Pool Task Execution
// ============================================================================

/**
 * A unit of work to perform on a provisioned scratch org.
 *
 * Tasks run after org creation during pool provisioning — deploying
 * packages, running scripts, configuring permissions, etc.
 *
 * Each task receives a `Logger` scoped to the scratch org it operates on.
 * Tasks are executed in the order they are registered. If a task fails
 * and its `continueOnError` property is `false` (the default), the
 * remaining tasks for that org are skipped.
 *
 * @example
 * ```typescript
 * const deployTask: PoolOrgTask = {
 *   name: 'deploy-packages',
 *   async execute(scratchOrg, logger) {
 *     logger.info(`Deploying to ${scratchOrg.auth.username}...`);
 *     await deployPackages(scratchOrg);
 *     logger.info('Deployment complete');
 *     return { success: true };
 *   },
 * };
 * ```
 */
export interface PoolOrgTask {
  /**
   * Whether provisioning should continue if this task fails.
   *
   * When `true`, the failure is recorded but subsequent tasks
   * still run. When `false` (default), remaining tasks for this
   * org are skipped on failure.
   */
  continueOnError?: boolean;

  /**
   * Execute the task against a scratch org.
   *
   * @param scratchOrg - The provisioned scratch org to operate on
   * @param logger - A logger scoped to this org (output destination
   *                 is determined by the `PoolOrgLoggerFactory`)
   * @returns Result indicating success or failure with details
   */
  execute(scratchOrg: ScratchOrg, logger: Logger): Promise<PoolOrgTaskResult>;

  /** Human-readable task name, used in events and log prefixes */
  name: string;
}

/**
 * Result of a single task execution on a scratch org.
 */
export interface PoolOrgTaskResult {
  /** Error message when `success` is false */
  error?: string;
  /** Whether the task completed successfully */
  success: boolean;
}

/**
 * Factory for creating loggers scoped to individual scratch orgs.
 *
 * Injected into the pool manager to control where per-org preparation
 * logs are written. The factory is called once per scratch org before
 * task execution begins.
 *
 * @example
 * ```typescript
 * class FileLoggerFactory implements PoolOrgLoggerFactory {
 *   constructor(private readonly baseDir: string) {}
 *
 *   create(scratchOrg: ScratchOrg): Logger {
 *     const logPath = path.join(this.baseDir, `${scratchOrg.auth.alias}.log`);
 *     return createFileLogger(logPath);
 *   }
 *
 *   async dispose(): Promise<void> {
 *     // Flush and close all file handles
 *   }
 * }
 * ```
 */
export interface PoolOrgLoggerFactory {
  /** Create a logger scoped to a specific scratch org */
  create(scratchOrg: ScratchOrg): Logger;

  /**
   * Clean up resources after all tasks have completed.
   *
   * Called once at the end of the provisioning run. Use this to
   * flush file handles, upload artifacts, or finalize structured
   * output.
   */
  dispose?(): Promise<void>;
}

// ============================================================================
// Pool Runtime State
// ============================================================================

/**
 * Ephemeral state tracked during a pool provisioning run.
 *
 * This is NOT configuration — it is computed at runtime by the pool
 * manager and should never appear in `sfpm.config.ts`.
 */
export interface PoolProvisioningState {
  /** Current number of active orgs in the pool */
  currentAllocation: number;
  /** Number of orgs that failed to create in this run */
  failedToCreate: number;
  /** Orgs currently in the pool */
  scratchOrgs: ScratchOrg[];
  /** Number of orgs that need to be created to reach target */
  toAllocate: number;
  /** Number needed to satisfy maximum allocation */
  toSatisfyMax: number;
  /** Number needed to satisfy minimum allocation */
  toSatisfyMin: number;
}
