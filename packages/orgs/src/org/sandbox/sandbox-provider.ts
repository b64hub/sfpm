import {escapeSOQL, soql} from '@b64hub/sfpm-core';
import {Org, OrgTypes, type SandboxRequest} from '@salesforce/core';
import {Duration} from '@salesforce/kit';
import {readFile} from 'node:fs/promises';

import type {OrgProvider} from '../org-provider.js';
import type {PoolOrg, PoolOrgRecord, PoolOrgUsage} from '../pool-org.js';
import type {Sandbox, SandboxCreateOptions} from './types.js';

import {generatePassword} from '../../index.js';
import {AllocationStatus, OrgError, PasswordResult} from '../types.js';
import {DEFAULT_SANDBOX} from './types.js';

// ============================================================================
// Record shapes
// ============================================================================

/**
 * Raw `SandboxInfo` record — standard Tooling API fields only.
 *
 * `SandboxInfo` is a Tooling API object and does **not** support custom
 * fields.  Pool metadata is stored on the separate shadow object
 * {@link SandboxPoolOrgRecord | Sandbox_Pool_Org__c}.
 */
export interface SandboxInfoRecord {
  AutoActivate?: boolean;
  CopyProgress?: number;
  CreatedDate?: string;
  Description?: string;
  EndDate?: string;
  Id?: string;
  LicenseType?: string;
  SandboxName?: string;
  SandboxOrganization?: string;
  Status?: string;
}

/**
 * Raw `Sandbox_Pool_Org__c` record shape.
 *
 * This is a custom object deployed to the production org that acts as a
 * "shadow" record for pool-managed sandboxes.  It holds the pool metadata
 * that cannot live directly on SandboxInfo (a Tooling API object).
 *
 * Fields:
 * - `Org_Id__c`  — Plain Text(18) holding the sandbox's 18-char org ID
 *   (matches `SandboxInfo.SandboxOrganization`).
 * - `Tag__c`     — Pool tag for grouping sandboxes.
 * - `Allocation_Status__c` — Picklist tracking the allocation lifecycle.
 * - `Auth_Url__c` — SFDX auth URL for authenticating to the sandbox.
 */
export interface SandboxPoolOrgRecord {
  Allocation_Status__c?: string;
  Auth_Url__c?: string;
  CreatedDate?: string;
  Id?: string;
  Name?: string;
  Org_Id__c?: string;
  Tag__c?: string;
}

/** The custom object API name used for sandbox pool metadata. */
const SANDBOX_POOL_ORG_OBJECT = 'Sandbox_Pool_Org__c';

const SANDBOX_INFO_FIELDS: (keyof SandboxInfoRecord)[] = [
  'AutoActivate',
  'CreatedDate',
  'EndDate',
  'Id',
  'LicenseType',
  'SandboxName',
  'SandboxOrganization',
  'Status',
];

const SANDBOX_POOL_ORG_FIELDS: (keyof SandboxPoolOrgRecord)[] = [
  'Allocation_Status__c',
  'Auth_Url__c',
  'CreatedDate',
  'Id',
  'Org_Id__c',
  'Tag__c',
];

const REQUIRED_ALLOCATION_STATUSES: AllocationStatus[] = [
  AllocationStatus.Available,
  AllocationStatus.Allocated,
  AllocationStatus.InProgress,
];

/**
 * Provider for managing sandboxes in a pool.
 *
 * Uses the `@salesforce/core` SDK's `Org.createSandbox()`, `Org.cloneSandbox()`,
 * and sandbox query methods for lifecycle operations (create, clone, delete,
 * status checks).
 *
 * Pool metadata (`Tag__c`, `Allocation_Status__c`, `Auth_Url__c`) is stored
 * on a separate **`Sandbox_Pool_Org__c`** custom object rather than on
 * `SandboxInfo` directly.  `SandboxInfo` is a Tooling API object that does
 * not support custom fields — the shadow object bridges this gap by holding
 * an `Org_Id__c` plain-text field that references the sandbox's 18-char
 * org ID from `SandboxInfo.SandboxOrganization`.
 *
 * Sandboxes created outside of pool provisioning will not have a
 * corresponding `Sandbox_Pool_Org__c` record, and that is expected.
 *
 * The hub org must be a **production org** with sandbox licenses and
 * the `Sandbox_Pool_Org__c` custom object deployed.
 *
 * @example
 * ```typescript
 * const prodOrg = await Org.create({ aliasOrUsername: 'my-prod-org' });
 * const provider = new SandboxProvider(prodOrg);
 *
 * await provider.validate();
 * const sandbox = await provider.createOrg({
 *   alias: 'SB1',
 *   sandboxName: 'SB1',
 *   licenseType: 'DEVELOPER',
 *   activationUserGroupId: '0GR000000000001',
 * });
 * ```
 */
/** Minimum interval (ms) between automatic prune runs per provider instance. */
const PRUNE_COOLDOWN_MS = 60_000;

export default class SandboxProvider implements OrgProvider<SandboxCreateOptions> {
  private readonly conn;
  private readonly hubOrg;
  private readonly hubUsername: string;
  /** Timestamp of the last successful prune run — used for cooldown. */
  private lastPruneTimestamp = 0;

  constructor(hubOrg: Org) {
    this.conn = hubOrg.getConnection();
    this.hubOrg = hubOrg;
    this.hubUsername = hubOrg.getUsername() ?? '';
  }

  async claimOrg(id: string): Promise<boolean> {
    try {
      const result = await this.conn.sobject(SANDBOX_POOL_ORG_OBJECT).update({
        Allocation_Status__c: 'Allocated' as const, // eslint-disable-line camelcase -- Salesforce custom field
        Id: id,
      });
      return result.success === true;
    } catch {
      return false;
    }
  }

  async createOrg(options: SandboxCreateOptions): Promise<PoolOrg> {
    const defContents = await this.readDefinitionFile(options.definitionFile);
    const waitMinutes = options.waitMinutes ?? DEFAULT_SANDBOX.waitMinutes;

    // Resolve sandbox name: namePattern override > definition sandboxName
    const baseName = options.namePattern ?? (defContents.SandboxName as string);
    const index = options.alias.replaceAll(/\D/g, '');
    const sandboxName = `${baseName}${index}`;

    // Override SandboxName with the generated pool name
    defContents.SandboxName = sandboxName;

    // Resolve human-readable name fields → Salesforce IDs
    if (defContents.ApexClassName) {
      defContents.ApexClassId = await this.resolveApexClassId(defContents.ApexClassName as string);
      delete defContents.ApexClassName;
    }

    if (defContents.ActivationUserGroupName) {
      defContents.ActivationUserGroupId = await this.getGroupId(defContents.ActivationUserGroupName as string);
      delete defContents.ActivationUserGroupName;
    }

    // Extract clone source fields (handled separately by cloneSandbox)
    const sourceSandboxName = defContents.SourceSandboxName as string | undefined;
    const sourceId = defContents.SourceId as string | undefined;
    delete defContents.SourceSandboxName;
    delete defContents.SourceId;

    // Pass remaining definition properties straight through as the SandboxRequest
    const sandboxRequest = defContents as SandboxRequest;

    let processResult;

    if (sourceSandboxName) {
      processResult = await this.hubOrg.cloneSandbox(sandboxRequest, sourceSandboxName, {
        interval: Duration.seconds(30),
        wait: Duration.minutes(waitMinutes),
      });
    } else if (sourceId) {
      processResult = await this.hubOrg.cloneSandbox(sandboxRequest, sourceId, {
        interval: Duration.seconds(30),
        wait: Duration.minutes(waitMinutes),
      });
    } else {
      processResult = await this.hubOrg.createSandbox(sandboxRequest, {
        async: false,
        interval: Duration.seconds(30),
        wait: Duration.minutes(waitMinutes),
      });
    }

    const orgId = processResult.SandboxOrganization ?? '';
    const sandboxUsername = orgId ? await this.resolveSandboxUsername(sandboxName) : '';

    // Create the shadow pool record for tracking this sandbox
    const poolRecord = await this.conn.sobject(SANDBOX_POOL_ORG_OBJECT).create({
      Allocation_Status__c: AllocationStatus.InProgress, // eslint-disable-line camelcase -- Salesforce custom field
      Org_Id__c: orgId, // eslint-disable-line camelcase -- Salesforce custom field
      Tag__c: '', // eslint-disable-line camelcase -- Salesforce custom field (set later by updatePoolMetadata)
    });

    const sandbox: Sandbox = {
      auth: {
        alias: options.alias,
        loginUrl: 'https://test.salesforce.com',
        username: sandboxUsername,
      },
      orgId,
      orgType: OrgTypes.Sandbox,
      pool: {
        status: AllocationStatus.InProgress,
        tag: '',
        timestamp: Date.now(),
      },
      recordId: poolRecord.id,
    };

    return sandbox;
  }

  async deleteOrgs(recordIds: string[]): Promise<void> {
    for (const recordId of recordIds) {
      try {
        // Look up the pool record to get the sandbox org ID
        // eslint-disable-next-line no-await-in-loop
        const poolRecord = (await this.conn.sobject(SANDBOX_POOL_ORG_OBJECT).retrieve(recordId)) as {
          Id: string;
          Org_Id__c: string;
        };

        if (poolRecord?.Org_Id__c) {
          // Find the sandbox name via SandboxProcess, then delete via SDK
          // eslint-disable-next-line no-await-in-loop
          const sandboxInfoResult = await this.conn.query<{Id: string; SandboxName: string}>(soql`SELECT Id, SandboxName FROM SandboxInfo WHERE SandboxOrganization = '${escapeSOQL(poolRecord.Org_Id__c)}'`);
          const sandboxName = sandboxInfoResult.records[0]?.SandboxName;
          if (sandboxName) {
            // eslint-disable-next-line no-await-in-loop
            const process = await this.hubOrg.querySandboxProcessBySandboxName(sandboxName);
            if (process?.SandboxOrganization) {
              // eslint-disable-next-line no-await-in-loop
              const sandboxOrg = await Org.create({aliasOrUsername: process.SandboxOrganization});
              // eslint-disable-next-line no-await-in-loop
              await sandboxOrg.deleteFrom(this.hubOrg);
            }
          }
        }
      } catch {
        // Best-effort sandbox deletion — always clean up the pool record
      }

      try {
        // Always delete the shadow pool record
        // eslint-disable-next-line no-await-in-loop
        await this.conn.sobject(SANDBOX_POOL_ORG_OBJECT).destroy(recordId);
      } catch {
        // Pool record may already have been deleted
      }
    }
  }

  async getActiveCountByTag(tag: string): Promise<number> {
    await this.pruneStalePoolRecords();

    const query = soql`SELECT count() FROM ${SANDBOX_POOL_ORG_OBJECT} WHERE Tag__c = '${escapeSOQL(tag)}'`;
    const result = await this.conn.query(query);
    return result.totalSize;
  }

  async getAvailableByTag(tag: string, myPool?: boolean): Promise<PoolOrg[]> {
    await this.pruneStalePoolRecords();

    const escapedTag = escapeSOQL(tag);
    const conditions = [
      `Tag__c = '${escapedTag}'`,
      `(Allocation_Status__c = '${AllocationStatus.Available}' OR Allocation_Status__c = '${AllocationStatus.InProgress}')`,
    ];

    if (myPool) {
      conditions.push(`CreatedById = '${escapeSOQL(this.hubUsername)}'`);
    }

    // Query pool records
    const poolQuery = soql`SELECT ${SANDBOX_POOL_ORG_FIELDS.join(', ')} FROM ${SANDBOX_POOL_ORG_OBJECT} WHERE ${conditions.join(' AND ')} ORDER BY CreatedDate DESC`;
    const poolResult = await this.conn.query<SandboxPoolOrgRecord>(poolQuery);

    if (poolResult.records.length === 0) return [];

    // Enrich with SandboxInfo data
    return this.enrichPoolRecords(poolResult.records);
  }

  async getOrgsByTag(tag?: string, myPool?: boolean): Promise<PoolOrg[]> {
    await this.pruneStalePoolRecords();

    const conditions: string[] = [];

    if (tag) {
      conditions.push(`Tag__c = '${escapeSOQL(tag)}'`);
    } else {
      conditions.push('Tag__c != null');
    }

    if (myPool) {
      conditions.push(`CreatedById = '${escapeSOQL(this.hubUsername)}'`);
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const poolQuery = soql`SELECT ${SANDBOX_POOL_ORG_FIELDS.join(', ')} FROM ${SANDBOX_POOL_ORG_OBJECT} ${whereClause} ORDER BY CreatedDate DESC`;
    const poolResult = await this.conn.query<SandboxPoolOrgRecord>(poolQuery);

    if (poolResult.records.length === 0) return [];

    return this.enrichPoolRecords(poolResult.records);
  }

  async getOrgUsageByUser(): Promise<PoolOrgUsage[]> {
    // Sandboxes don't have a direct equivalent of ActiveScratchOrg usage tracking.
    // Capacity is tracked via license limits (getRemainingCapacity) instead.
    return [];
  }

  /**
   * Find active sandboxes that have no corresponding pool record.
   *
   * Performs an in-memory diff: queries all active `SandboxInfo` records
   * and all `Sandbox_Pool_Org__c` records, then returns sandboxes whose
   * org ID is not tracked by any pool record.
   */
  async getOrphanedOrgs(): Promise<PoolOrg[]> {
    // Fetch all active sandboxes
    const sandboxQuery = soql`SELECT ${SANDBOX_INFO_FIELDS.join(', ')} FROM SandboxInfo WHERE Status = 'Active' ORDER BY CreatedDate DESC`;
    const sandboxResult = await this.conn.query<SandboxInfoRecord>(sandboxQuery);

    if (sandboxResult.records.length === 0) return [];

    // Fetch all known pool org IDs
    const poolQuery = soql`SELECT Org_Id__c FROM ${SANDBOX_POOL_ORG_OBJECT}`;
    const poolResult = await this.conn.query<{Org_Id__c: string}>(poolQuery);

    const managedOrgIds = new Set(poolResult.records.map(r => r.Org_Id__c));

    // Return sandboxes not tracked by the pool
    return sandboxResult.records
    .filter(r => r.SandboxOrganization && !managedOrgIds.has(r.SandboxOrganization))
    .map(r => mapFromSandboxInfo(r));
  }

  async getRecordIds(orgs: PoolOrg[]): Promise<PoolOrg[]> {
    if (orgs.length === 0) return orgs;

    // Look up Sandbox_Pool_Org__c records by org ID
    const missingIds = orgs.filter(org => !org.recordId && org.orgId);
    if (missingIds.length === 0) return orgs;

    const orgIdList = missingIds.map(org => `'${escapeSOQL(org.orgId)}'`).join(',');
    const query = soql`SELECT Id, Org_Id__c FROM ${SANDBOX_POOL_ORG_OBJECT} WHERE Org_Id__c IN (${orgIdList})`;
    const result = await this.conn.query<{Id: string; Org_Id__c: string}>(query);

    const idMap = new Map<string, string>();
    for (const record of result.records) {
      if (record.Org_Id__c) {
        idMap.set(record.Org_Id__c, record.Id);
      }
    }

    for (const org of missingIds) {
      const recordId = idMap.get(org.orgId);
      if (recordId) {
        org.recordId = recordId;
      }
    }

    return orgs;
  }

  async getRemainingCapacity(): Promise<number> {
    // The /limits REST API does not expose sandbox entitlements reliably.
    // Instead, query TenantUsageEntitlement (Tooling API) for the total
    // sandbox allowance, then subtract currently active sandboxes.
    try {
      const entitlementQuery = 'SELECT Setting, CurrentAmountAllowed FROM TenantUsageEntitlement WHERE Setting LIKE \'%Sandbox%\'';
      const entitlementResult = await this.conn.query<{CurrentAmountAllowed: number; Setting: string}>(entitlementQuery);

      let totalAllowed = 0;
      for (const record of entitlementResult.records) {
        totalAllowed += record.CurrentAmountAllowed ?? 0;
      }

      if (totalAllowed === 0) {
        // No entitlement records found — cannot determine capacity.
        // Return maxAllocation so the caller proceeds and fails
        // gracefully at create-time if the org truly has no licenses.
        return Number.MAX_SAFE_INTEGER;
      }

      const activeCount = await this.getActiveSandboxCount();

      return Math.max(0, totalAllowed - activeCount);
    } catch {
      // TenantUsageEntitlement may not be queryable (permissions, API version).
      // Return unbounded so provisioning proceeds — Salesforce will reject
      // the create call with a clear error if no licenses remain.
      return Number.MAX_SAFE_INTEGER;
    }
  }

  async isOrgActive(username: string): Promise<boolean> {
    // Look up the sandbox by resolving its name from the username suffix
    const sandboxName = this.extractSandboxName(username);
    if (!sandboxName) return false;

    try {
      const process = await this.hubOrg.querySandboxProcessBySandboxName(sandboxName);
      return process?.Status === 'Completed' || process?.Status === 'Active';
    } catch {
      return false;
    }
  }

  async setPassword(username: string, password?: string): Promise<PasswordResult> {
    const newPassword = password ?? await generatePassword();
    // await this.setUserPassword(username, newPassword); TODO
    return {password: newPassword};
  }

  /** Update fields on a SandboxInfo record (standard fields only). */
  async updateOrgInfo(fields: Record<string, unknown> & {Id: string}): Promise<boolean> {
    const result = await this.conn.sobject('SandboxInfo').update(fields);
    return result.success === true;
  }

  async updatePoolMetadata(records: PoolOrgRecord[]): Promise<void> {
    if (records.length === 0) return;

    const updates = records.map(r => ({
      Allocation_Status__c: r.allocationStatus, // eslint-disable-line camelcase -- Salesforce custom field
      Auth_Url__c: r.authUrl, // eslint-disable-line camelcase -- Salesforce custom field
      Id: r.id,
      Tag__c: r.poolTag, // eslint-disable-line camelcase -- Salesforce custom field
    }));

    const results = await this.conn.sobject(SANDBOX_POOL_ORG_OBJECT).update(updates);
    const failures = (Array.isArray(results) ? results : [results]).filter(r => !r.success);
    if (failures.length > 0 && failures.length === updates.length) {
      const errors = failures.flatMap(f => (f as {errors?: {message: string}[]}).errors?.map(e => e.message) ?? ['unknown error']);
      throw new OrgError('update', `Failed to update pool metadata on all ${failures.length} record(s): ${errors.join('; ')}`);
    }
  }

  async validate(): Promise<void> {
    // Prune stale records on validation — this is typically the first
    // operation in a pool lifecycle (PoolManager.provision calls validate
    // before anything else).
    await this.pruneStalePoolRecords();

    let describe;
    try {
      describe = await this.conn.sobject(SANDBOX_POOL_ORG_OBJECT).describe();
    } catch {
      throw new OrgError(
        'prerequisite',
        `The custom object "${SANDBOX_POOL_ORG_OBJECT}" was not found. `
        + 'Deploy the sfpm sandbox pool custom object to your production org before running sandbox pool operations.',
      );
    }

    const orgIdField = describe.fields.find(f => f.name === 'Org_Id__c');
    if (!orgIdField) {
      throw new OrgError(
        'prerequisite',
        `${SANDBOX_POOL_ORG_OBJECT} is missing the "Org_Id__c" field. `
        + 'Deploy the sfpm sandbox pool custom object to your production org.',
      );
    }

    const tagField = describe.fields.find(f => f.name === 'Tag__c');
    if (!tagField) {
      throw new OrgError(
        'prerequisite',
        `${SANDBOX_POOL_ORG_OBJECT} is missing the "Tag__c" field. `
        + 'Deploy the sfpm sandbox pool custom object to your production org.',
      );
    }

    const allocationField = describe.fields.find(f => f.name === 'Allocation_Status__c');
    if (!allocationField) {
      throw new OrgError(
        'prerequisite',
        `${SANDBOX_POOL_ORG_OBJECT} is missing the "Allocation_Status__c" field. `
        + 'Deploy the sfpm sandbox pool custom object to your production org.',
      );
    }

    const picklistValues = new Set((allocationField.picklistValues ?? []).map(v => v.value));
    const missing = REQUIRED_ALLOCATION_STATUSES.filter(s => !picklistValues.has(s));

    if (missing.length > 0) {
      throw new OrgError(
        'prerequisite',
        `Allocation_Status__c on ${SANDBOX_POOL_ORG_OBJECT} is missing required picklist values: ${missing.join(', ')}. `
        + `Update the picklist on ${SANDBOX_POOL_ORG_OBJECT} in your production org.`,
        {context: {existing: [...picklistValues], missing}},
      );
    }

    const authUrlField = describe.fields.find(f => f.name === 'Auth_Url__c');
    if (!authUrlField) {
      throw new OrgError(
        'prerequisite',
        `${SANDBOX_POOL_ORG_OBJECT} is missing the "Auth_Url__c" field. `
        + 'Deploy the sfpm sandbox pool custom object to your production org.',
      );
    }
  }

  /**
   * Enrich pool records with standard `SandboxInfo` fields.
   *
   * Queries `SandboxInfo` by org IDs found on the pool records, then
   * merges both result sets into `Sandbox` domain objects.
   *
   * Pool records whose `Org_Id__c` has no matching active `SandboxInfo`
   * record are silently dropped — they represent stale shadow records
   * for sandboxes that were deleted or expired outside of pool management.
   * These will be cleaned up by the next prune cycle.
   */
  private async enrichPoolRecords(poolRecords: SandboxPoolOrgRecord[]): Promise<Sandbox[]> {
    const orgIds = poolRecords
    .map(r => r.Org_Id__c)
    .filter(Boolean);

    if (orgIds.length === 0) {
      return poolRecords.map(r => mapFromPoolRecord(r));
    }

    const orgIdList = orgIds.map(orgId => `'${escapeSOQL(orgId!)}'`).join(',');
    const infoQuery = soql`SELECT ${SANDBOX_INFO_FIELDS.join(', ')} FROM SandboxInfo WHERE SandboxOrganization IN (${orgIdList})`;
    const infoResult = await this.conn.query<SandboxInfoRecord>(infoQuery);

    // Index SandboxInfo records by org ID for fast lookup
    const infoMap = new Map<string, SandboxInfoRecord>();
    for (const record of infoResult.records) {
      if (record.SandboxOrganization) {
        infoMap.set(record.SandboxOrganization, record);
      }
    }

    // Only return pool records that have a matching SandboxInfo — stale
    // records (deleted / expired sandboxes) are filtered out so that
    // callers never see phantom orgs.
    return poolRecords
    .filter(poolRec => {
      if (!poolRec.Org_Id__c) return true; // no org ID yet (e.g. In Progress)
      return infoMap.has(poolRec.Org_Id__c);
    })
    .map(poolRec => {
      const info = poolRec.Org_Id__c ? infoMap.get(poolRec.Org_Id__c) : undefined;
      return mapFromPoolRecord(poolRec, info);
    });
  }

  /**
   * Extract the sandbox name suffix from a username.
   *
   * Salesforce sandbox usernames follow the pattern `user@example.com.sandboxname`.
   */
  private extractSandboxName(username: string): string | undefined {
    const parts = username.split('.');
    return parts.length > 2 ? parts.at(-1) : undefined;
  }

  /** Count sandboxes currently active on the production org. */
  private async getActiveSandboxCount(): Promise<number> {
    const result = await this.conn.query(soql`SELECT count() FROM SandboxInfo WHERE Status IN ('Active', 'Completed')`);
    return result.totalSize;
  }

  private async getGroupId(groupName: string): Promise<string> {
    const query = soql`SELECT Id FROM Group WHERE Name = '${escapeSOQL(groupName)}'`;
    const result = await this.conn.query<{Id: string}>(query);

    if (result.records.length === 0) {
      throw new OrgError('fetch', `No group found with name ${groupName} in the devhub org.`);
    }

    return result.records[0].Id;
  }

  /**
   * Remove `Sandbox_Pool_Org__c` records whose associated sandbox no
   * longer exists or has been deleted.
   *
   * Compares all pool records' `Org_Id__c` values against `SandboxInfo`
   * to find stale references, then bulk-deletes them.  Runs at most once
   * per {@link PRUNE_COOLDOWN_MS} within the same provider instance so
   * that repeated pool operations in a single session do not hammer the
   * API.
   *
   * This is intentionally fire-and-forget: failures are swallowed so that
   * pruning never blocks the primary operation.
   */
  private async pruneStalePoolRecords(): Promise<void> {
    // Cooldown — skip if we pruned recently
    if (Date.now() - this.lastPruneTimestamp < PRUNE_COOLDOWN_MS) return;

    try {
      // 1. Fetch all pool records
      const poolQuery = soql`SELECT Id, Org_Id__c FROM ${SANDBOX_POOL_ORG_OBJECT}`;
      const poolResult = await this.conn.query<{Id: string; Org_Id__c?: string}>(poolQuery);

      if (poolResult.records.length === 0) {
        this.lastPruneTimestamp = Date.now();
        return;
      }

      // 2. Collect org IDs that have a value
      const orgIdToPoolIds = new Map<string, string[]>();
      const noOrgIdPoolIds: string[] = [];

      for (const rec of poolResult.records) {
        if (rec.Org_Id__c) {
          const list = orgIdToPoolIds.get(rec.Org_Id__c) ?? [];
          list.push(rec.Id);
          orgIdToPoolIds.set(rec.Org_Id__c, list);
        } else {
          // Pool records with no Org_Id__c are stale by definition
          noOrgIdPoolIds.push(rec.Id);
        }
      }

      // 3. Query SandboxInfo to see which org IDs still exist
      const stalePoolIds: string[] = [...noOrgIdPoolIds];

      if (orgIdToPoolIds.size > 0) {
        const orgIdList = [...orgIdToPoolIds.keys()].map(id => `'${escapeSOQL(id)}'`).join(',');
        const infoQuery = soql`SELECT SandboxOrganization FROM SandboxInfo WHERE SandboxOrganization IN (${orgIdList})`;
        const infoResult = await this.conn.query<{SandboxOrganization: string}>(infoQuery);

        const activeOrgIds = new Set(infoResult.records.map(r => r.SandboxOrganization));

        for (const [orgId, poolIds] of orgIdToPoolIds) {
          if (!activeOrgIds.has(orgId)) {
            stalePoolIds.push(...poolIds);
          }
        }
      }

      // 4. Bulk-delete stale pool records
      if (stalePoolIds.length > 0) {
        await this.conn.sobject(SANDBOX_POOL_ORG_OBJECT).destroy(stalePoolIds);
      }

      this.lastPruneTimestamp = Date.now();
    } catch {
      // Pruning is best-effort — never break the primary operation
      this.lastPruneTimestamp = Date.now();
    }
  }

  /**
   * Read a sandbox definition JSON file and capitalize keys to match
   * the Salesforce API field names (e.g., `sandboxName` → `SandboxName`).
   *
   * Returns a mutable record so the caller can override/remove fields
   * before passing it to the SDK.
   */
  private async readDefinitionFile(filePath: string): Promise<Record<string, unknown>> {
    try {
      const content = await readFile(filePath, 'utf8');
      const parsed = JSON.parse(content) as Record<string, unknown>;
      return Object.fromEntries(Object.entries(parsed).map(([key, value]) => [key.charAt(0).toUpperCase() + key.slice(1), value]));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new OrgError('prerequisite', `Failed to read sandbox definition file "${filePath}": ${message}`);
    }
  }

  /** Resolve an Apex class name to its Salesforce ID. */
  private async resolveApexClassId(className: string): Promise<string> {
    const result = await this.conn.query<{Id: string}>(soql`SELECT Id FROM ApexClass WHERE Name = '${escapeSOQL(className)}'`);

    if (result.records.length === 0) {
      throw new OrgError('prerequisite', `No Apex class found with name "${className}"`);
    }

    return result.records[0].Id;
  }

  /**
   * Resolve the sandbox username from the sandbox name.
   *
   * The sandbox username is `<production-username>.<sandboxname>`.
   */
  private async resolveSandboxUsername(sandboxName: string): Promise<string> {
    // The hub username is the production org username
    return `${this.hubUsername}.${sandboxName}`;
  }
}

// ============================================================================
// Mapping helpers
// ============================================================================

/**
 * Map a `Sandbox_Pool_Org__c` record (with optional `SandboxInfo` enrichment)
 * to the domain `Sandbox` type.
 */
function mapFromPoolRecord(poolRecord: SandboxPoolOrgRecord, info?: SandboxInfoRecord): Sandbox {
  const orgId = poolRecord.Org_Id__c ?? info?.SandboxOrganization ?? '';
  const sandboxName = info?.SandboxName ?? '';
  const tag = poolRecord.Tag__c ?? '';
  const status = (poolRecord.Allocation_Status__c ?? '') as AllocationStatus;

  return {
    auth: {
      authUrl: poolRecord.Auth_Url__c,
      loginUrl: 'https://test.salesforce.com',
      username: sandboxName ? `${sandboxName}` : '',
    },
    expiry: info?.EndDate ? new Date(info.EndDate).getTime() : undefined,
    orgId,
    orgType: OrgTypes.Sandbox,
    pool: {
      status,
      tag,
      timestamp: poolRecord.CreatedDate ? new Date(poolRecord.CreatedDate).getTime() : Date.now(),
    },
    recordId: poolRecord.Id,
  };
}

/**
 * Map a plain `SandboxInfo` record to a `Sandbox` domain object.
 *
 * Used for orphaned sandboxes that have no pool record — pool metadata
 * fields are left empty.
 */
function mapFromSandboxInfo(record: SandboxInfoRecord): Sandbox {
  const orgId = record.SandboxOrganization ?? '';
  const sandboxName = record.SandboxName ?? '';

  return {
    auth: {
      loginUrl: 'https://test.salesforce.com',
      username: sandboxName ? `${sandboxName}` : '',
    },
    expiry: record.EndDate ? new Date(record.EndDate).getTime() : undefined,
    orgId,
    orgType: OrgTypes.Sandbox,
    pool: {
      status: '' as AllocationStatus,
      tag: '',
      timestamp: record.CreatedDate ? new Date(record.CreatedDate).getTime() : Date.now(),
    },
  };
}
