import type {Logger} from '@b64/sfpm-core';

import {AuthInfo} from '@salesforce/core';

import type {ScratchOrg} from './org/scratch/types.js';

// ============================================================================
// Authentication
// ============================================================================

/**
 * JWT bearer flow configuration.
 *
 * Mirrors the fields required by `@salesforce/core` `AuthInfo.create()`
 * when `privateKey` is present. The Connected App must have a digital
 * certificate uploaded that pairs with the private key.
 *
 * For scratch orgs created from a JWT-authenticated DevHub, the library
 * automatically inherits the `clientId` and `privateKey` via the
 * `parentUsername` mechanism — so you typically only configure this
 * once for the DevHub.
 *
 * @example
 * ```typescript
 * const jwtConfig: JwtAuthConfig = {
 *   clientId: 'CONNECTED_APP_CONSUMER_KEY',
 *   loginUrl: 'https://login.salesforce.com',
 *   privateKeyPath: '/path/to/server.key',
 * };
 * ```
 */
export interface JwtAuthConfig {
  /** Connected App consumer key (client ID) */
  clientId: string;
  /** Login URL for the org (default: https://login.salesforce.com) */
  loginUrl?: string;
  /** Absolute path to the PEM-encoded RSA private key file */
  privateKeyPath: string;
}

// ============================================================================
// Hub Org Abstraction
// ============================================================================

/**
 * Abstraction over a Salesforce DevHub.
 *
 * Decouples org-service from @salesforce/core so the orgs package
 * depends only on sfpm-core types. The concrete implementation
 * (`DevHubService`) bridges this interface to the real Salesforce SDK.
 */
export interface DevHub {
  /** Create a scratch org against this DevHub */
  createScratchOrg(request: ScratchOrgCreateRequest): Promise<ScratchOrgCreateResult>;

  /** Delete active scratch org records by their IDs */
  deleteActiveScratchOrgs(recordIds: string[]): Promise<void>;

  /** Generate and set a password for a scratch org user */
  generatePassword(username: string): Promise<PasswordResult>;

  /**
   * Retrieve JWT auth configuration for the hub.
   *
   * Returns the `clientId` and `privateKeyPath` used to authenticate.
   * Scratch orgs inherit the DevHub's Connected App credentials
   * automatically via the `parentUsername` mechanism.
   */
  getJwtConfig(): JwtAuthConfig;

  /**
   * Find active scratch orgs that have no pool tag.
   *
   * Queries `ScratchOrgInfo WHERE Pooltag__c = null AND Status = 'Active'`.
   * Useful for cleanup operations to identify orgs that were created
   * outside of the pool lifecycle or whose tag was cleared.
   */
  getOrphanedScratchOrgs(): Promise<ScratchOrg[]>;

  /**
   * Look up a ScratchOrgInfo record ID by its SignupUsername.
   *
   * Uses the DevHub's `ScratchOrgInfo` sobject to find the record
   * matching the given username. Returns the record ID or `undefined`
   * if no match is found.
   */
  getScratchOrgInfoByUsername(username: string): Promise<string | undefined>;

  /**
   * Get scratch org usage counts grouped by user email.
   *
   * Queries `ActiveScratchOrg` and groups by `SignupEmail`, returning
   * the count per user ordered by usage descending. Useful for
   * reporting and capacity planning.
   */
  getScratchOrgUsageByUser(): Promise<ScratchOrgUsage[]>;

  /**
   * Look up a user's email address by their username.
   *
   * Queries the `User` SObject in the DevHub. Retries up to 3 times
   * to handle transient API failures.
   */
  getUserEmail(username: string): Promise<string>;

  /** Returns the hub org username */
  getUsername(): string;

  /** Send a simple email via the connected org's REST API */
  sendEmail(options: SendEmailOptions): Promise<void>;

  /** Set a local alias for a username */
  setAlias(username: string, alias: string): Promise<void>;

  /**
   * Set a password for a user via the DevHub.
   *
   * Looks up the user by username and assigns the given password.
   * Use this in combination with `generatePassword()` utility when you
   * need explicit control over password generation vs assignment.
   *
   * @param username - The username of the org/user to set password for
   * @param password - The password to assign
   */
  setUserPassword(username: string, password: string): Promise<void>;

  /**
   * Update fields on a ScratchOrgInfo record.
   *
   * Wraps `connection.sobject('ScratchOrgInfo').update()`. The `id` field
   * is required to identify the record; all other fields are merged.
   *
   * @param fields - Object with `Id` and any ScratchOrgInfo fields to update
   * @returns `true` if the update succeeded
   */
  updateScratchOrgInfo(fields: Record<string, unknown> & {Id: string}): Promise<boolean>;
}

// ============================================================================
// Scratch Org Query Types
// ============================================================================

/**
 * Scratch org usage count for a single user.
 *
 * Returned by `DevHub.getScratchOrgUsageByUser()`. Maps to
 * the `SELECT count(id) In_Use, SignupEmail FROM ActiveScratchOrg
 * GROUP BY SignupEmail` aggregate query.
 */
export interface ScratchOrgUsage {
  /** Number of active scratch orgs owned by this user */
  count: number;
  /** The user's signup email address */
  email: string;
}

// ============================================================================
// Pool Configuration (decomposed from legacy PoolConfig)
// ============================================================================

/**
 * Scratch org creation defaults used when provisioning orgs for a pool.
 *
 * These settings control how individual scratch orgs are created.
 * They can be overridden per-invocation via `CreateScratchOrgOptions`.
 */
export interface ScratchOrgDefaults {
  /** Path to the scratch org definition file (e.g., `config/project-scratch-def.json`) */
  definitionFile: string;
  /** Number of days until scratch orgs expire (default: 7) */
  expiryDays?: number;
  /** Max retries on transient creation failures (default: 3) */
  maxRetries?: number;
  /** Whether to exclude ancestor package versions (default: false) */
  noAncestors?: boolean;
  /** Max minutes to wait for org creation (default: 6) */
  waitMinutes?: number;
}

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
 * Controls how packages are deployed into pooled scratch orgs
 * after creation.
 */
export interface PoolDeploymentConfig {
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
}

/**
 * Network and security settings applied to pooled scratch orgs.
 */
export interface PoolNetworkConfig {
  /** Specific IP ranges to relax (only used if `relaxAllIPRanges` is false) */
  ipRangesToBeRelaxed?: string[];
  /** Relax all IP range restrictions (default: false) */
  relaxAllIPRanges?: boolean;
}

/**
 * Configuration for fetching pre-built artifacts into pooled scratch orgs.
 *
 * Supports either a custom script or npm registry fetching.
 */
export interface PoolArtifactFetchConfig {
  /** Path to a custom script that fetches artifacts */
  artifactFetchScript?: string;
  /** Fetch artifacts from an npm registry */
  npm?: {
    /** Path to `.npmrc` for authentication */
    npmrcPath?: string;
    /** npm scope to fetch from (e.g., `@myorg`) */
    scope: string;
  };
}

/**
 * Lifecycle script paths executed during pool provisioning.
 *
 * These are legacy script hooks. Prefer `sfpm.config.ts` lifecycle hooks
 * for new integrations — they provide type safety and composability.
 */
export interface PoolScriptsConfig {
  /** Script to run after package deployment into the scratch org */
  postDeploymentScriptPath?: string;
  /** Script to run before dependency installation */
  preDependencyInstallationScriptPath?: string;
}

/**
 * Full pool configuration composed from focused sub-configs.
 *
 * Replaces the legacy monolithic `PoolConfig`. Each concern is
 * separated into its own interface for clarity and reuse.
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
  deployment?: PoolDeploymentConfig;

  /** Enable Vlocity/OmniStudio support (default: false) */
  enableVlocity?: boolean;

  /** Artifact fetching configuration */
  fetchArtifacts?: PoolArtifactFetchConfig;

  /** Network/IP relaxation settings */
  network?: PoolNetworkConfig;

  /** Release config file for pool-based releases */
  releaseConfigFile?: string;

  /** Retry the full provisioning flow on failure (default: false) */
  retryOnFailure?: boolean;

  /** Scratch org creation defaults */
  scratchOrg: ScratchOrgDefaults;

  /** Legacy script hooks (prefer sfpm.config.ts hooks instead) */
  scripts?: PoolScriptsConfig;

  /** Pool sizing constraints */
  sizing: PoolSizingConfig;

  /** Use an existing snapshot pool as a base (pool tag) */
  snapshotPool?: string;

  /** Tag identifying this pool (used for claiming/releasing orgs) */
  tag: string;
}

// ============================================================================
// Pool Infrastructure
// ============================================================================

/**
 * Allocation status values for scratch orgs managed by a pool.
 *
 * Mirrors the picklist on the DevHub's `ScratchOrgInfo.Allocation_Status__c`.
 */
export type AllocationStatus = 'Allocate' | 'Assigned' | 'Available' | 'In Progress' | 'Return';

/**
 * Abstracts DevHub-side queries for pool state.
 *
 * The pool manager needs to know current scratch org counts and limits
 * to compute allocation. This interface decouples that from the
 * Salesforce SDK — adapters implement it at the CLI layer.
 *
 * At the CLI layer, this is typically implemented alongside `PoolOrgSource`
 * since both query the same `ScratchOrgInfo` sobject.
 */
export interface PoolInfoProvider {
  /** Count active scratch orgs with a given pool tag */
  getActiveCountByTag(tag: string): Promise<number>;

  /** Fetch the DevHub record IDs for a list of scratch orgs (by orgId) */
  getRecordIds(scratchOrgs: ScratchOrg[]): Promise<ScratchOrg[]>;

  /** Get the remaining scratch org capacity on the DevHub */
  getRemainingCapacity(): Promise<number>;

  /** Check if a scratch org is still active (not deleted) */
  isOrgActive(username: string): Promise<boolean>;

  /** Update scratch org pool metadata (tag, status, auth info) */
  updatePoolMetadata(records: PoolOrgRecord[]): Promise<void>;
}

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
 * Abstracts the data source for available pool scratch orgs.
 *
 * Used by `PoolFetcher` to query and claim orgs from an existing pool.
 * This is separated from `PoolInfoProvider` because the concerns
 * differ: `PoolInfoProvider` manages pool *state* (counts, capacity),
 * while `PoolOrgSource` handles org *retrieval* and *allocation*.
 *
 * At the CLI layer, both interfaces are typically implemented by the
 * same adapter class since they query the same DevHub sobject.
 */
export interface PoolOrgProvider {
  /**
   * Claim a scratch org for use (optimistic concurrency).
   *
   * Sets the org's allocation status to `'Allocate'`. Returns `true`
   * if the claim succeeded, `false` if another consumer claimed it first.
   */
  claimOrg(id: string): Promise<boolean>;

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
}

// ============================================================================
// Pool Prerequisites
// ============================================================================

/**
 * Validates that the DevHub has the required configuration for pool operations.
 *
 * Checks that the `Allocation_Status__c` picklist values are present
 * on the `ScratchOrgInfo` sobject.
 *
 * Implement this interface at the CLI layer where you have access to
 * the Salesforce SDK for describing sobjects.
 *
 * @example
 * ```typescript
 * class DevHubPrerequisiteChecker implements PoolPrerequisiteChecker {
 *   constructor(private readonly hubOrg: Org) {}
 *
 *   async validate(): Promise<void> {
 *     const describe = await this.hubOrg.getConnection()
 *       .sobject('ScratchOrgInfo').describe();
 *     // Check for Allocation_Status__c picklist values.
 *   }
 * }
 * ```
 */
export interface PoolPrerequisiteChecker {
  /** Validate DevHub prerequisites. Throws `OrgError` if not met. */
  validate(): Promise<void>;
}

// ============================================================================
// Pool Fetching
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

  /** Authenticate to a scratch org via JWT. Returns true on success. */
  login(scratchOrg: ScratchOrg): Promise<AuthInfo>;
}

/**
 * Options for fetching a single scratch org from a pool.
 */
export interface PoolFetchOptions {
  /** Enable source tracking after fetching */
  enableSourceTracking?: boolean;
  /** Only return orgs owned by the current user */
  myPool?: boolean;
  /**
   * Only return orgs with valid authentication credentials.
   *
   * When true, candidates are filtered through
   * `PoolOrgAuthenticator.hasValidAuth()` — typically checking
   * that the org has a `username` and `loginURL` for JWT auth.
   */
  requireValidAuth?: boolean;
  /** Email address to send the org details to instead of logging in locally */
  sendToUser?: string;
  /** Pool tag to fetch from */
  tag: string;
}

/**
 * Options for fetching multiple scratch orgs from a pool.
 *
 * Unlike `PoolFetchOptions`, fetching all does NOT claim individual orgs.
 * The caller is responsible for updating allocation status as needed
 * (e.g., when transferring orgs from a snapshot pool).
 */
export interface PoolFetchAllOptions extends PoolFetchOptions {
  /** Maximum number of orgs to fetch */
  limit?: number;
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
 * The logger implementation varies by context:
 *
 * - **CLI**: Writes to a per-org log file (`.sfpm/prepare_logs/{alias}.log`)
 * - **GitHub Action**: Structured output, group annotations, artifact uploads
 * - **Tests**: In-memory logger for assertions
 *
 * Tasks are executed in the order they are registered. If a task fails
 * and its `continueOnError` property is `false` (the default), the
 * remaining tasks for that org are skipped.
 *
 * @example
 * ```typescript
 * const deployTask: PoolOrgTask = {
 *   name: 'deploy-packages',
 *   async execute(scratchOrg, logger) {
 *     logger.info(`Deploying to ${scratchOrg.username}...`);
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
 * Implementations are context-specific:
 *
 * - **CLI** (`FileLoggerFactory`): Creates a logger that writes to
 *   `.sfpm/prepare_logs/{alias}.log`. Useful for local debugging —
 *   developers can tail the file or review after the run.
 *
 * - **GitHub Action** (`ActionsLoggerFactory`): Creates a logger that
 *   emits `::group::` / `::endgroup::` annotations and optionally
 *   uploads log content as workflow artifacts.
 *
 * - **Test** (`InMemoryLoggerFactory`): Captures log lines in an
 *   array for test assertions. No filesystem or network I/O.
 *
 * If no factory is provided, the pool manager falls back to its
 * injected `Logger` instance (or silent no-op if none).
 *
 * @example
 * ```typescript
 * class FileLoggerFactory implements PoolOrgLoggerFactory {
 *   constructor(private readonly baseDir: string) {}
 *
 *   create(scratchOrg: ScratchOrg): Logger {
 *     const logPath = path.join(this.baseDir, `${scratchOrg.alias}.log`);
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
// Pool Runtime State (separated from config)
// ============================================================================

/**
 * Ephemeral state tracked during a pool provisioning run.
 *
 * This was previously mixed into PoolConfig. It is NOT configuration —
 * it is computed at runtime by the pool manager and should never
 * appear in `sfpm.config.ts`.
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

// ============================================================================
// Org Configuration for sfpm.config.ts
// ============================================================================

/**
 * Org-level configuration that plugs into `sfpm.config.ts`.
 *
 * Provides project-wide defaults for org operations. Individual
 * commands can override these at invocation time.
 *
 * @example
 * ```typescript
 * // sfpm.config.ts
 * import { defineConfig } from '@b64/sfpm-core';
 * import { defineOrgConfig } from '@b64/sfpm-orgs';
 *
 * export default defineConfig({
 *   hooks: [],
 *   orgs: defineOrgConfig({
 *     scratchOrg: {
 *       definitionFile: 'config/project-scratch-def.json',
 *       expiryDays: 7,
 *     },
 *     pool: {
 *       tag: 'dev-pool',
 *       sizing: { maxAllocation: 10, minAllocation: 2 },
 *     },
 *   }),
 * });
 * ```
 */
export interface OrgConfig {
  /** Default network settings applied to all provisioned orgs */
  network?: PoolNetworkConfig;

  /** Pool configuration(s). A single pool or an array of named pools. */
  pool?: PoolConfig | PoolConfig[];

  /** Default scratch org settings applied to all create operations */
  scratchOrg?: Partial<ScratchOrgDefaults>;
}

/** Default scratch org creation settings. */
export const DEFAULT_SCRATCH_ORG: Required<Pick<ScratchOrgDefaults, 'expiryDays' | 'maxRetries' | 'noAncestors' | 'waitMinutes'>> = {
  expiryDays: 7,
  maxRetries: 3,
  noAncestors: false,
  waitMinutes: 6,
};

/** Default pool sizing when not explicitly configured. */
export const DEFAULT_POOL_SIZING: Required<Pick<PoolSizingConfig, 'batchSize' | 'minAllocation'>> = {
  batchSize: 5,
  minAllocation: 0,
};

/**
 * Identity function for type-safe org configuration authoring.
 *
 * @example
 * ```typescript
 * import { defineOrgConfig } from '@b64/sfpm-orgs';
 *
 * const orgs = defineOrgConfig({
 *   scratchOrg: { definitionFile: 'config/project-scratch-def.json' },
 *   pool: { tag: 'dev', sizing: { maxAllocation: 10 } },
 * });
 * ```
 */
export function defineOrgConfig(config: OrgConfig): OrgConfig {
  return config;
}

// ============================================================================
// Scratch Org Types
// ============================================================================

/**
 * Configuration for creating a scratch org.
 */
export interface ScratchOrgCreateRequest {
  /** Path to the scratch org definition file */
  definitionFile: string;
  /** Number of days until the org expires */
  durationDays: number;
  /** Whether to exclude ancestor versions */
  noAncestors?: boolean;
  /** Whether to exclude namespace from the org */
  noNamespace?: boolean;
  /** Number of retries on transient failures */
  retries?: number;
  /** Max minutes to wait for org creation */
  waitMinutes?: number;
}

/**
 * Result returned from the hub after scratch org creation.
 */
export interface ScratchOrgCreateResult {
  loginUrl: string;
  orgId: string;
  username: string;
  warnings?: string[];
}

/**
 * Result from password generation.
 */
export interface PasswordResult {
  password: string | undefined;
}

/**
 * Options for sending an email through the org's REST API.
 */
export interface SendEmailOptions {
  body: string;
  subject: string;
  to: string;
}

// ============================================================================
// OrgService Options
// ============================================================================

/**
 * Options for creating a scratch org through OrgService.
 */
export interface CreateScratchOrgOptions {
  /** Local alias for the scratch org */
  alias: string;
  /** Path to the scratch org definition file */
  definitionFile: string;
  /** Number of days until the org expires (default: 7) */
  expiryDays?: number;
  /** Whether to exclude ancestor versions */
  noAncestors?: boolean;
  /** Max minutes to wait for org creation (default: 6) */
  waitMinutes?: number;
}

/**
 * Options for sharing a scratch org via email.
 */
export interface ShareScratchOrgOptions {
  /** Email address to send the org details to */
  emailAddress: string;
}

// ============================================================================
// OrgService Events
// ============================================================================

/**
 * Event map for OrgService. Used with EventEmitter for
 * type-safe event handling.
 */
export interface OrgServiceEvents {
  'scratch:create:complete': [payload: {alias: string; elapsedMs: number; orgId: string; timestamp: Date; username: string}];
  'scratch:create:error': [payload: {alias: string; error: string; timestamp: Date}];
  'scratch:create:start': [payload: {alias: string; definitionFile: string; timestamp: Date}];
  'scratch:delete:complete': [payload: {orgIds: string[]; timestamp: Date}];
  'scratch:delete:start': [payload: {orgIds: string[]; timestamp: Date}];
  'scratch:share:complete': [payload: {emailAddress: string; timestamp: Date; username: string}];
  'scratch:status:complete': [payload: {status: AllocationStatus; timestamp: Date; username: string}];
}

// ============================================================================
// Errors
// ============================================================================

/**
 * Error that occurs during org operations (create, delete, share, etc.).
 *
 * Follows the SFPM error pattern: structured context, display formatting,
 * and error chain preservation.
 */
export class OrgError extends Error {
  public readonly context: Record<string, unknown>;
  public readonly operation: 'auth' | 'create' | 'delete' | 'fetch' | 'password' | 'prerequisite' | 'share' | 'update';
  public readonly orgIdentifier?: string;
  public readonly timestamp: Date;

  constructor(
    operation: OrgError['operation'],
    message: string,
    options?: {
      cause?: Error;
      context?: Record<string, unknown>;
      orgIdentifier?: string;
    },
  ) {
    super(message);
    this.name = 'OrgError';
    this.timestamp = new Date();
    this.operation = operation;
    this.orgIdentifier = options?.orgIdentifier;
    this.context = options?.context ?? {};

    if (options?.cause) {
      this.cause = options.cause;
      if (options.cause.stack) {
        this.stack = `${this.stack}\nCaused by: ${options.cause.stack}`;
      }
    }

    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, OrgError);
    }
  }

  public toDisplayMessage(): string {
    const parts: string[] = [`Org ${this.operation} failed`];

    if (this.orgIdentifier) {
      parts.push(`Org: ${this.orgIdentifier}`);
    }

    parts.push(`Error: ${this.message}`);

    if (this.cause instanceof Error) {
      parts.push(`Cause: ${this.cause.message}`);
    }

    return parts.join('\n');
  }

  public toJSON(): Record<string, unknown> {
    return {
      cause: this.cause instanceof Error
        ? {message: this.cause.message, name: this.cause.name}
        : undefined,
      context: this.context,
      message: this.message,
      operation: this.operation,
      orgIdentifier: this.orgIdentifier,
      timestamp: this.timestamp.toISOString(),
      type: this.name,
    };
  }
}
