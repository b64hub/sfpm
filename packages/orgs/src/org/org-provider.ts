import type {PoolOrg, PoolOrgUsage, PoolOrgRecord} from './pool-org.js';
import type {SandboxCreateOptions} from './sandbox/types.js';
import type {ScratchOrgCreateOptions} from './scratch/types.js';
import type {PasswordResult} from './types.js';

/**
 * The pool's need to find and claim available orgs.
 *
 * Used by `PoolFetcher` to query candidates and optimistically
 * claim one for a consumer.
 */
export interface PoolOrgClaimer {
  /**
   * Claim an org for use (optimistic concurrency).
   *
   * Sets the org's allocation status to `'Allocated'`. Returns `true`
   * if the claim succeeded, `false` if another consumer claimed it first.
   */
  claimOrg(id: string): Promise<boolean>;

  /**
   * Query available orgs in a pool.
   *
   * @param tag - Pool tag to filter by
   * @param myPool - When true, only return orgs created by the current user
   * @returns Available orgs with metadata populated
   */
  getAvailableByTag(tag: string, myPool?: boolean): Promise<PoolOrg[]>;
}

/**
 * The pool's need to provision, delete, and manage orgs.
 *
 * Used by `PoolManager` to create orgs, validate the hub,
 * manage pool metadata, and clean up the pool.
 */
export interface PoolOrgProvisioner<TCreateOptions = OrgCreateOptions> {
  /**
   * Create a new org (scratch org or sandbox).
   *
   * Returns the created org with basic auth information populated.
   * The caller is responsible for setting pool metadata after creation.
   */
  createOrg(options: TCreateOptions): Promise<PoolOrg>;

  /**
   * Delete org records by their IDs.
   *
   * For scratch orgs this deletes `ActiveScratchOrg` records.
   * For sandboxes this uses `Org.deleteFrom()` via the SDK.
   */
  deleteOrgs(recordIds: string[]): Promise<void>;


  /** Count active orgs with a given pool tag */
  getActiveCountByTag(tag: string): Promise<number>;

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

  /** Check if an org is still active (not deleted) */
  isOrgActive(username: string): Promise<boolean>;

  /**
   * Generate and set a password for an org user.
   *
   * For scratch orgs, generates a random password and sets it via SOAP.
   * For sandboxes, this may be a no-op (sandbox users inherit production passwords).
   */
  setPassword(username: string, password?: string): Promise<PasswordResult>;

  /** Update org pool metadata (tag, status, auth info) */
  updatePoolMetadata(records: PoolOrgRecord[]): Promise<void>;

  /** Validate hub prerequisites (custom fields, picklist values). Throws `OrgError` if not met. */
  validate(): Promise<void>;
}

/**
 * The pool's need to inspect org state for reporting and admin operations.
 *
 * Used by admin commands (and `DevHubService`) for orphan discovery,
 * usage reporting, and ad-hoc record updates.
 */
export interface PoolOrgInspector {
  /**
   * Find active orgs that have no pool tag.
   *
   * Returns orgs created outside of the pool lifecycle or whose
   * pool tag was cleared. Useful for cleanup operations.
   */
  getOrphanedOrgs(): Promise<PoolOrg[]>;

  /**
   * Get org usage counts grouped by user email.
   *
   * Queries active orgs and groups by user, returning the count per
   * user ordered by usage descending. Useful for reporting and capacity planning.
   */
  getOrgUsageByUser(): Promise<PoolOrgUsage[]>;

  /**
   * Update fields on an org info record.
   *
   * For scratch orgs, updates `ScratchOrgInfo`.
   * For sandboxes, updates `SandboxInfo`.
   *
   * @param fields - Object with `Id` and any fields to update
   * @returns `true` if the update succeeded
   */
  updateOrgInfo(fields: Record<string, unknown> & {Id: string}): Promise<boolean>;
}

/**
 * Unified provider interface for org-type-specific pool operations.
 *
 * Combines all pool-need facets into a single contract. Each
 * implementation handles one org type (scratch org or sandbox) and
 * encapsulates all interaction with the hub org's SObjects. The pool
 * layer depends only on the facet it needs — consumers never branch
 * on org type directly.
 *
 * Facets:
 * - {@link PoolOrgClaimer} — Find and claim available orgs (`PoolFetcher`)
 * - {@link PoolOrgProvisioner} — Provision, delete, manage orgs (`PoolManager`)
 * - {@link PoolOrgInspector} — Reporting and admin queries
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
export type OrgProvider<TCreateOptions = OrgCreateOptions> =
  PoolOrgClaimer &
  PoolOrgInspector &
  PoolOrgProvisioner<TCreateOptions>;


/**
 * Union of all org-type-specific create options.
 *
 * `PoolManager` works with this union when the concrete org type is not
 * known at compile time. Concrete `OrgProvider<T>` implementations narrow
 * to their specific options type for compile-time safety.
 */
export type OrgCreateOptions = SandboxCreateOptions | ScratchOrgCreateOptions;
