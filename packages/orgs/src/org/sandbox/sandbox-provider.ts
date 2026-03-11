import {escapeSOQL, soql} from '@b64/sfpm-core';
import {Org, OrgTypes} from '@salesforce/core';
import {Duration} from '@salesforce/kit';

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
export default class SandboxProvider implements OrgProvider<SandboxCreateOptions> {
  private readonly conn;
  private readonly hubOrg;
  private readonly hubUsername: string;

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
    const sandboxName = options.sandboxName ?? options.alias;
    const licenseType = options.licenseType ?? DEFAULT_SANDBOX.licenseType;
    const waitMinutes = options.waitMinutes ?? DEFAULT_SANDBOX.waitMinutes;
    const groupId = await this.getGroupId(options.activationUserGroupName ?? DEFAULT_SANDBOX.groupName);

    const sandboxRequest = {
      ActivationUserGroupId: groupId,
      ApexClassId: options.apexClassId,
      LicenseType: licenseType,
      SandboxName: sandboxName,
    };

    let processResult;

    if (options.sourceSandboxName) {
      // Clone from an existing sandbox using the proper SDK API
      processResult = await this.hubOrg.cloneSandbox(sandboxRequest, options.sourceSandboxName, {
        interval: Duration.seconds(30),
        wait: Duration.minutes(waitMinutes),
      });
    } else {
      // Create a new sandbox using the proper SDK API
      processResult = await this.hubOrg.createSandbox(sandboxRequest, {
        async: false,
        interval: Duration.seconds(30),
        wait: Duration.minutes(waitMinutes),
      });
    }

    const orgId = processResult.SandboxOrganization ?? '';

    // Derive the sandbox username (production username + sandbox name suffix)
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
        groupId,
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
    const query = soql`SELECT count() FROM ${SANDBOX_POOL_ORG_OBJECT} WHERE Tag__c = '${escapeSOQL(tag)}'`;
    const result = await this.conn.query(query);
    return result.totalSize;
  }

  async getAvailableByTag(tag: string, myPool?: boolean): Promise<PoolOrg[]> {
    const escapedTag = escapeSOQL(tag);
    const conditions = [
      `Tag__c = '${escapedTag}'`,
      String.raw`(Allocation_Status__c = 'Available' OR Allocation_Status__c = 'In Progress')`,
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

  async getOrgsByTag(tag: string, myPool?: boolean): Promise<PoolOrg[]> {
    const conditions = [`Tag__c = '${escapeSOQL(tag)}'`];

    if (myPool) {
      conditions.push(`CreatedById = '${escapeSOQL(this.hubUsername)}'`);
    }

    const poolQuery = soql`SELECT ${SANDBOX_POOL_ORG_FIELDS.join(', ')} FROM ${SANDBOX_POOL_ORG_OBJECT} WHERE ${conditions.join(' AND ')} ORDER BY CreatedDate DESC`;
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
    const apiVersion = this.conn.getApiVersion();
    const limits = await this.conn.request<Record<string, {Max: number; Remaining: number}>>(`/services/data/v${apiVersion}/limits`);

    // Salesforce exposes sandbox limits under 'DeveloperSandbox', 'DeveloperProSandbox', etc.
    // Aggregate remaining across all sandbox types
    let remaining = 0;
    for (const key of Object.keys(limits)) {
      if (key.toLowerCase().includes('sandbox')) {
        remaining += limits[key]?.Remaining ?? 0;
      }
    }

    return remaining;
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

    await this.conn.sobject(SANDBOX_POOL_ORG_OBJECT).update(updates);
  }

  async validate(): Promise<void> {
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
   */
  private async enrichPoolRecords(poolRecords: SandboxPoolOrgRecord[]): Promise<Sandbox[]> {
    const orgIds = poolRecords
    .map(r => r.Org_Id__c)
    .filter(Boolean);

    if (orgIds.length === 0) {
      return poolRecords.map(r => mapFromPoolRecord(r));
    }

    const orgIdList = orgIds.map(id => `'${escapeSOQL(id)}'`).join(',');
    const infoQuery = soql`SELECT ${SANDBOX_INFO_FIELDS.join(', ')} FROM SandboxInfo WHERE SandboxOrganization IN (${orgIdList})`;
    const infoResult = await this.conn.query<SandboxInfoRecord>(infoQuery);

    // Index SandboxInfo records by org ID for fast lookup
    const infoMap = new Map<string, SandboxInfoRecord>();
    for (const record of infoResult.records) {
      if (record.SandboxOrganization) {
        infoMap.set(record.SandboxOrganization, record);
      }
    }

    return poolRecords.map(poolRec => {
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

  private async getGroupId(groupName: string): Promise<string> {
    const query = soql`SELECT Id FROM Group WHERE Name = '${escapeSOQL(groupName)}'`;
    const result = await this.conn.query<{Id: string}>(query);

    if (result.records.length === 0) {
      throw new OrgError('fetch', `No group found with name ${groupName} in the devhub org.`);
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
