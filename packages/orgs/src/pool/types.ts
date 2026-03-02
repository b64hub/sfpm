import type {Logger} from '@b64/sfpm-core';

import {Org, OrgTypes} from '@salesforce/core';

import type {PoolOrg} from '../org/pool-org.js';
import type {SandboxDefaults} from '../org/sandbox/types.js';
import type {ScratchOrgDefaults} from '../org/types.js';

/**
 * Pool sizing configuration — how many orgs to maintain.
 *
 * `minAllocation` and `maxAllocation` define the target range.
 * The pool manager ensures the pool stays within these bounds.
 */
export interface PoolSizingConfig {
  /** Number of orgs to create per provisioning batch (default: 5) */
  batchSize?: number;
  /** Maximum number of orgs in the pool */
  maxAllocation: number;
  /** Minimum number of orgs to maintain (default: 0) */
  minAllocation?: number;
}

/**
 * Shared pool configuration fields common to all pool types.
 *
 * Extracted so that `ScratchOrgPoolConfig` and `SandboxPoolConfig`
 * don't duplicate these properties.
 */
export interface PoolConfigBase {
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

/**
 * Pool configuration for scratch org pools.
 *
 * @example
 * ```typescript
 * const pool: ScratchOrgPoolConfig = {
 *   type: 'scratch',
 *   tag: 'dev-pool',
 *   scratchOrg: {
 *     definitionFile: 'config/project-scratch-def.json',
 *     expiryDays: 7,
 *   },
 *   sizing: { maxAllocation: 10, minAllocation: 2, batchSize: 5 },
 * };
 * ```
 */
export interface ScratchOrgPoolConfig extends PoolConfigBase {
  scratchOrg: ScratchOrgDefaults;
  type: OrgTypes.Scratch;
}

/**
 * Pool configuration for sandbox pools.
 *
 * @example
 * ```typescript
 * const pool: SandboxPoolConfig = {
 *   type: 'sandbox',
 *   tag: 'sb-pool',
 *   sandbox: {
 *     namePattern: 'SB',
 *     licenseType: 'DEVELOPER',
 *     groupId: '0GR000000000001',
 *   },
 *   sizing: { maxAllocation: 5, batchSize: 2 },
 * };
 * ```
 */
export interface SandboxPoolConfig extends PoolConfigBase {
  sandbox: SandboxDefaults;
  type: OrgTypes.Sandbox;
}

/**
 * Pool configuration — discriminated union of scratch org and sandbox pools.
 *
 * Use `config.type` to narrow:
 * ```typescript
 * if (config.type === 'sandbox') {
 *   config.sandbox.licenseType; // safe
 * }
 * ```
 */
export type PoolConfig = SandboxPoolConfig | ScratchOrgPoolConfig;

/** Default pool sizing when not explicitly configured. */
export const DEFAULT_POOL_SIZING: Required<Pick<PoolSizingConfig, 'batchSize' | 'minAllocation'>> = {
  batchSize: 5,
  minAllocation: 0,
};

/**
 * Handles authentication to orgs fetched from a pool.
 *
 * The primary authentication mechanism is the SFDX auth URL stored
 * on the org's hub record (`Auth_Url__c`). When an auth URL is not
 * available, implementations may fall back to JWT `parentUsername`
 * (scratch orgs) or other mechanisms.
 *
 * Implement at the CLI layer where `@salesforce/core` is available.
 * The adapter is provided via DI to `PoolFetcher`.
 */
export interface PoolOrgAuthenticator {
  /** Enable source tracking for a claimed org */
  enableSourceTracking?(org: PoolOrg): Promise<void>;

  /** Whether the org has valid authentication credentials */
  hasValidAuth(org: PoolOrg): boolean;

  /** Authenticate to an org (auth URL first, JWT fallback). */
  login(org: PoolOrg): Promise<void>;
}

/**
 * Action to execute after an org has been claimed from the pool.
 *
 * Post-claim actions form a composable pipeline — each action runs
 * in order after a successful claim. Common actions include:
 * - Authentication (`authenticator.login`)
 * - Source tracking setup (`authenticator.enableSourceTracking`)
 * - Sharing via email (`devHub.shareOrg`)
 *
 * The caller (CLI, factory, actions) composes the appropriate set of
 * actions based on the use case.
 *
 * @param org - The claimed org
 */
export type PostClaimAction = (org: PoolOrg) => Promise<void>;

/**
 * Options for fetching orgs from a pool.
 *
 * Used for both single-org fetch (claims via optimistic concurrency)
 * and multi-org fetch (no claiming — caller manages allocation).
 *
 * Authentication and other post-claim behaviors are composed via
 * `postClaimActions` rather than baked into the fetcher. The caller
 * decides which actions to include.
 */
export interface PoolFetchOptions {
  /** Maximum number of orgs to fetch (only used with fetchAll) */
  limit?: number;
  /** Only return orgs owned by the current user */
  myPool?: boolean;
  /**
   * Pipeline of actions to run after claiming/fetching.
   *
   * Actions run sequentially per org, but different orgs are processed
   * in parallel. If any action throws for an org, that org is filtered
   * out of the result. Non-fatal actions should catch internally and log.
   *
   * @example
   * ```typescript
   * {
   *   postClaimActions: [
   *     (org) => authenticator.login(org),
   *     (org) => authenticator.enableSourceTracking(org),
   *   ]
   * }
   * ```
   */
  postClaimActions?: PostClaimAction[];
  /** Pool tag to fetch from */
  tag: string;
}

// ============================================================================
// Pool Deletion
// ============================================================================

/**
 * Options for deleting orgs from a pool.
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
 * A unit of work to perform on a provisioned org.
 *
 * Tasks run after org creation during pool provisioning — deploying
 * packages, running scripts, configuring permissions, etc.
 *
 * Each task receives a `Logger` scoped to the org it operates on.
 * Tasks are executed in the order they are registered. If a task fails
 * and its `continueOnError` property is `false` (the default), the
 * remaining tasks for that org are skipped.
 *
 * @example
 * ```typescript
 * const deployTask: PoolOrgTask = {
 *   name: 'deploy-packages',
 *   async execute(org, logger) {
 *     logger.info(`Deploying to ${org.auth.username}...`);
 *     await deployPackages(org);
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
   * Execute the task against a provisioned org.
   *
   * @param org - The provisioned org to operate on
   * @param logger - A logger scoped to this org (output destination
   *                 is determined by the `PoolOrgLoggerFactory`)
   * @returns Result indicating success or failure with details
   */
  execute(org: PoolOrg, logger: Logger): Promise<PoolOrgTaskResult>;

  /** Human-readable task name, used in events and log prefixes */
  name: string;
}

/**
 * Result of a single task execution on an org.
 */
export interface PoolOrgTaskResult {
  /** Error message when `success` is false */
  error?: string;
  /** Whether the task completed successfully */
  success: boolean;
}

/**
 * Factory for creating loggers scoped to individual pool orgs.
 *
 * Injected into the pool manager to control where per-org preparation
 * logs are written. The factory is called once per org before
 * task execution begins.
 *
 * @example
 * ```typescript
 * class FileLoggerFactory implements PoolOrgLoggerFactory {
 *   constructor(private readonly baseDir: string) {}
 *
 *   create(org: PoolOrg): Logger {
 *     const logPath = path.join(this.baseDir, `${org.auth.alias}.log`);
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
  /** Create a logger scoped to a specific org */
  create(org: PoolOrg): Logger;

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
  orgs: PoolOrg[];
  /** Number of orgs that need to be created to reach target */
  toAllocate: number;
  /** Number needed to satisfy maximum allocation */
  toSatisfyMax: number;
  /** Number needed to satisfy minimum allocation */
  toSatisfyMin: number;
}
