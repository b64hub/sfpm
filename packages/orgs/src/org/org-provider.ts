import type {PoolOrgRecord} from '../pool/types.js';
import type {PoolOrg} from './pool-org.js';
import type {PasswordResult} from './types.js';

// ============================================================================
// OrgProvider — Unified interface for org-type-specific operations
// ============================================================================

/**
 * Unified provider interface for org-type-specific pool operations.
 *
 * Combines org lifecycle (create, delete, password) with pool
 * query/claim/metadata operations into a single contract. Each
 * implementation handles one org type (scratch org or sandbox) and
 * encapsulates all interaction with the hub org's SObjects. The pool
 * layer (`PoolManager`, `PoolFetcher`) depends only on this interface
 * — it never branches on org type directly.
 *
 * Implementors:
 * - `ScratchOrgProvider` — Queries `ScratchOrgInfo` / `ActiveScratchOrg`;
 *   creates via `Org.scratchOrgCreate()`
 * - `SandboxProvider` — Queries `SandboxInfo` / `SandboxProcess`;
 *   creates via `Org.createSandbox()`
 *
 * @example
 * ```typescript
 * // Provider is selected at factory time, not at runtime
 * const provider: OrgProvider = poolType === 'sandbox'
 *   ? new SandboxProvider(hubOrg)
 *   : new ScratchOrgProvider(hubOrg);
 *
 * const manager = new PoolManager({ provider, logger });
 * ```
 */
export interface OrgProvider {
  // -- Pool query & claim --

  /**
   * Claim an org for use (optimistic concurrency).
   *
   * Sets the org's allocation status to `'Allocate'`. Returns `true`
   * if the claim succeeded, `false` if another consumer claimed it first.
   */
  claimOrg(id: string): Promise<boolean>;

  /**
   * Create a new org (scratch org or sandbox).
   *
   * Returns the created org with basic auth information populated.
   * The caller is responsible for setting pool metadata after creation.
   */
  createOrg(options: OrgCreateOptions): Promise<PoolOrg>;

  /**
   * Delete org records by their IDs.
   *
   * For scratch orgs this deletes `ActiveScratchOrg` records.
   * For sandboxes this uses `Org.deleteFrom()` via the SDK.
   */
  deleteOrgs(recordIds: string[]): Promise<void>;

  /**
   * Generate and set a password for an org user.
   *
   * For scratch orgs, generates a random password and sets it via SOAP.
   * For sandboxes, this may be a no-op (sandbox users inherit production passwords).
   */
  generatePassword(username: string): Promise<PasswordResult>;

  /** Count active orgs with a given pool tag */
  getActiveCountByTag(tag: string): Promise<number>;

  /**
   * Query available orgs in a pool.
   *
   * @param tag - Pool tag to filter by
   * @param myPool - When true, only return orgs created by the current user
   * @returns Available orgs with metadata populated
   */
  getAvailableByTag(tag: string, myPool?: boolean): Promise<PoolOrg[]>;

  /**
   * Query all orgs in a pool regardless of status.
   *
   * Returns orgs with all allocation statuses (Available, In Progress,
   * Assigned, etc.). Used by pool deletion to find orgs to remove.
   * Each returned org should include its `recordId` when the org is still active.
   *
   * @param tag - Pool tag to filter by
   * @param myPool - When true, only return orgs created by the current user
   * @returns All pool orgs with metadata populated
   */
  getOrgsByTag(tag: string, myPool?: boolean): Promise<PoolOrg[]>;

  /** Fetch the hub record IDs for a list of orgs (by orgId) */
  getRecordIds(orgs: PoolOrg[]): Promise<PoolOrg[]>;

  /** Get the remaining org capacity on the hub */
  getRemainingCapacity(): Promise<number>;

  // -- Org lifecycle --

  /** Returns the hub org username. */
  getUsername(): string;

  /** Check if an org is still active (not deleted) */
  isOrgActive(username: string): Promise<boolean>;

  /** Update org pool metadata (tag, status, auth info) */
  updatePoolMetadata(records: PoolOrgRecord[]): Promise<void>;

  /** Validate hub prerequisites (custom fields, picklist values). Throws `OrgError` if not met. */
  validate(): Promise<void>;
}

// ============================================================================
// OrgProvider Supporting Types
// ============================================================================

/**
 * Options for creating an org through a provider.
 *
 * Provider implementations map these generic options to the
 * org-type-specific SDK calls.
 */
export interface OrgCreateOptions {
  /** Group ID for sandbox access */
  activationUserGroupId?: string;

  // -- Scratch org specific (ignored by SandboxProvider) --

  /** Local alias for the org (e.g., `SO1`, `SB1`) */
  alias: string;
  /** Apex class ID for post-copy script */
  apexClassId?: string;
  /** Whether to auto-activate the sandbox */
  autoActivate?: boolean;

  // -- Sandbox specific (ignored by ScratchOrgProvider) --

  /** Path to the scratch org definition file */
  definitionFile?: string;
  /** Number of days until the org expires */
  expiryDays?: number;
  /** Sandbox license type */
  licenseType?: string;
  /** Whether to exclude ancestor versions */
  noAncestors?: boolean;
  /** Max retries on transient failures */
  retries?: number;
  /** Sandbox name */
  sandboxName?: string;

  // -- Shared --

  /** Source sandbox name for cloning */
  sourceSandboxName?: string;
  /** Max minutes to wait for creation */
  waitMinutes?: number;
}
