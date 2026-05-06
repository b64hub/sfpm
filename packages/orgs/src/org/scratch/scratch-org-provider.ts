import {escapeSOQL, soql} from '@b64hub/sfpm-core';
import {
  AuthInfo, Connection, Org, OrgTypes,
  type ScratchOrgRequest,
} from '@salesforce/core';
import {Duration} from '@salesforce/kit';

import type {OrgProvider} from '../org-provider.js';
import type {PoolOrg, PoolOrgRecord, PoolOrgUsage} from '../pool-org.js';

import generatePassword from '../../utils/password-generator.js';
import setAlias from '../../utils/set-alias.js';
import {
  AllocationStatus, OrgError,
  PasswordResult,
} from '../types.js';
import {
  DEFAULT_SCRATCH_ORG,
  type PoolScratchOrgCreateResult, type ScratchOrg, type ScratchOrgInfoRecord,
} from './types.js';

/**
 * Raw ActiveScratchOrg record shape as returned from SOQL queries.
 */
export interface ActiveScratchOrgRecord {
  Id?: string;
  ScratchOrg?: string;
  ScratchOrgInfoId?: string;
  SignupUsername?: string;
}

export const SCRATCH_ORG_INFO_FIELDS: (keyof ScratchOrgInfoRecord)[] = [
  'Allocation_Status__c',
  'CreatedDate',
  'ExpirationDate',
  'Id',
  'LoginUrl',
  'Tag__c',
  'ScratchOrg',
  'Auth_Url__c',
  'AuthCode',
  'SignupEmail',
  'SignupUsername',
];

const REQUIRED_ALLOCATION_STATUSES: AllocationStatus[] = [
  AllocationStatus.Available,
  AllocationStatus.Allocated,
  AllocationStatus.InProgress,
  AllocationStatus.Return,
];

/**
 * Normalize a Salesforce ID to 15-char (case-sensitive) form.
 *
 * Salesforce IDs come in two flavours: 15-char (case-sensitive) and
 * 18-char (case-insensitive, with a 3-char checksum suffix).
 * `ScratchOrgInfo.ScratchOrg` stores 15-char IDs, while
 * `scratchOrgCreate()` returns 18-char IDs. Truncating to 15 chars
 * lets us match them reliably in JavaScript Map lookups.
 */
function to15CharId(id: string): string {
  return id.slice(0, 15);
}

/**
 * Provider for managing scratch orgs in a pool.
 *
 * Queries `ScratchOrgInfo` and `ActiveScratchOrg` SObjects in the DevHub.
 * Creates scratch orgs via `Org.scratchOrgCreate()`.
 *
 * Also provides DevHub-level utilities (email, alias, JWT config) that
 * are shared across providers but naturally live on the hub org.
 */
export default class ScratchOrgProvider implements OrgProvider<ScratchOrgRequest> {
  private readonly conn;
  private readonly hubOrg;

  constructor(hubOrg: Org) {
    if (!hubOrg.isDevHubOrg) {
      throw new Error('Provided org must be a devhub org');
    }

    this.conn = hubOrg.getConnection();
    this.hubOrg = hubOrg;
  }

  async claimOrg(id: string): Promise<boolean> {
    try {
      const result = await this.conn.sobject('ScratchOrgInfo').update({
        Allocation_Status__c: 'Allocated' as const, // eslint-disable-line camelcase -- Salesforce custom field
        Id: id,
      });
      return result.success === true;
    } catch {
      return false;
    }
  }

  async cleanupOrgs(orgs: PoolOrg[]): Promise<void> {
    const usernames = orgs.map(o => o.auth.username).filter(Boolean) as string[];
    if (usernames.length === 0) return;

    try {
      await Promise.all(usernames.map(async username => {
        const scratchOrg = await Org.create({aliasOrUsername: username});
        await scratchOrg.deleteFrom(this.hubOrg);
      }));
    } catch {
      // Best-effort — swallow errors per interface contract
    }
  }

  async createOrg(options: ScratchOrgRequest): Promise<PoolOrg> {
    const result = await this.createScratchOrg({
      ...options,
      durationDays: options.durationDays ?? DEFAULT_SCRATCH_ORG.expiryDays,
      noancestors: options.noancestors ?? DEFAULT_SCRATCH_ORG.noAncestors,
      nonamespace: options.nonamespace ?? false,
      retry: options.retry ?? DEFAULT_SCRATCH_ORG.maxRetries,
      wait: options.wait ?? Duration.minutes(DEFAULT_SCRATCH_ORG.waitMinutes),
    });
    const username = result.username ?? '';
    const orgId = result.authFields?.orgId ?? '';

    if (options.alias) {
      await setAlias(username, options.alias);
    }

    const scratchOrg: ScratchOrg = {
      auth: {
        alias: options.alias,
        loginUrl: result.authFields?.loginUrl ?? result.authFields?.instanceUrl ?? '',
        username,
      },
      orgId,
      orgType: OrgTypes.Scratch,
    };

    // const passwordResult = await this.setPassword(username);
    // if (passwordResult.password) {
    //   scratchOrg.auth.password = passwordResult.password;
    // }

    // Use authInfo from the creation result to get the SFDX auth URL
    try {
      const authUrl = result.authInfo?.getSfdxAuthUrl();
      if (authUrl) {
        scratchOrg.auth.authUrl = authUrl;
      }
    } catch {
      // Auth URL generation is best-effort; JWT fallback is available for scratch orgs
    }

    return scratchOrg;
  }

  async deleteOrgs(recordIds: string[]): Promise<void> {
    for (const recordId of recordIds) {
      // eslint-disable-next-line no-await-in-loop -- sequential deletion avoids overwhelming the API
      await this.conn.sobject('ActiveScratchOrg').destroy(recordId);
    }
  }

  async getActiveCountByTag(tag: string): Promise<number> {
    const query = soql`SELECT count() FROM ScratchOrgInfo WHERE Tag__c = '${escapeSOQL(tag)}' AND Status = 'Active'`;
    const result = await this.conn.query(query);
    return result.totalSize;
  }

  async getAvailableByTag(tag: string, myPool?: boolean): Promise<PoolOrg[]> {
    const escapedTag = escapeSOQL(tag);
    const conditions = [
      `Tag__c = '${escapedTag}'`,
      "Status = 'Active'",
      `(Allocation_Status__c = '${AllocationStatus.Available}' OR Allocation_Status__c = '${AllocationStatus.InProgress}')`,
    ];

    const username: string = this.hubOrg.getUsername()!;

    if (myPool) {
      conditions.push(`CreatedById = '${escapeSOQL(username)}'`);
    }

    const query = soql`SELECT ${SCRATCH_ORG_INFO_FIELDS.join(', ')} FROM ScratchOrgInfo WHERE ${conditions.join(' AND ')} ORDER BY CreatedDate DESC`;
    const result = await this.conn.query<ScratchOrgInfoRecord>(query);
    return result.records.map(r => mapToScratchOrg(r));
  }

  async getOrgsByTag(tag: string, myPool?: boolean): Promise<PoolOrg[]> {
    let query = soql`SELECT ${SCRATCH_ORG_INFO_FIELDS.join(', ')} FROM ScratchOrgInfo WHERE Tag__c = '${escapeSOQL(tag)}' AND Allocation_Status__c = 'Active'`;

    const username: string = this.hubOrg.getUsername()!;

    if (myPool) {
      query += ` AND CreatedById = '${escapeSOQL(username)}'`;
    }

    query += ' ORDER BY CreatedDate DESC';

    const result = await this.conn.query<ScratchOrgInfoRecord>(query);
    const orgs = result.records.map(r => mapToScratchOrg(r));

    if (orgs.length > 0) {
      await this.resolveActiveRecordIds(result.records, orgs as ScratchOrg[]);
    }

    return orgs;
  }

  /** Get org usage counts grouped by user email. */
  async getOrgUsageByUser(): Promise<PoolOrgUsage[]> {
    const query = soql`SELECT count(Id) In_Use, SignupEmail FROM ActiveScratchOrg GROUP BY SignupEmail ORDER BY count(Id) DESC`;
    const result = await this.conn.query<{In_Use: number; SignupEmail: string}>(query);
    return result.records.map(r => ({count: r.In_Use, email: r.SignupEmail}));
  }

  /** Find active orgs that have no pool tag. */
  async getOrphanedOrgs(): Promise<PoolOrg[]> {
    const query = soql`SELECT ${SCRATCH_ORG_INFO_FIELDS.join(', ')} FROM ScratchOrgInfo WHERE Tag__c = null AND Allocation_Status__c = 'Active' ORDER BY CreatedDate DESC`;
    const result = await this.conn.query<ScratchOrgInfoRecord>(query);
    return result.records.map(r => mapToScratchOrg(r));
  }

  async getRecordIds(orgs: PoolOrg[]): Promise<PoolOrg[]> {
    if (orgs.length === 0) return orgs;

    const missingIds = orgs.filter(org => !org.recordId && org.orgId);
    if (missingIds.length === 0) return orgs;

    // Primary lookup: by orgId (ScratchOrg field).
    // Normalize to 15-char keys — ScratchOrgInfo.ScratchOrg stores 15-char IDs
    // while authFields.orgId from scratchOrgCreate() returns 18-char IDs.
    const orgIdMap = new Map<string, PoolOrg>();
    for (const org of missingIds) {
      orgIdMap.set(to15CharId(org.orgId), org);
    }

    const idList = [...orgIdMap.keys()].map(id => `'${escapeSOQL(id)}'`).join(',');
    const query = soql`SELECT Id, ScratchOrg FROM ScratchOrgInfo WHERE ScratchOrg IN (${idList})`;
    const result = await this.conn.query<{Id: string; ScratchOrg: string}>(query);

    for (const record of result.records) {
      if (record.ScratchOrg) {
        const org = orgIdMap.get(to15CharId(record.ScratchOrg));
        if (org) {
          org.recordId = record.Id;
        }
      }
    }

    return orgs;
  }

  async getRemainingCapacity(): Promise<number> {
    const apiVersion = this.conn.getApiVersion();
    const limits = await this.conn.request<Record<string, {Max: number; Remaining: number}>>(`/services/data/v${apiVersion}/limits`);
    return limits.ActiveScratchOrgs?.Remaining ?? 0;
  }

  /** Look up a ScratchOrgInfo record ID by username. */
  async getScratchOrgInfoByUsername(username: string): Promise<string | undefined> {
    const query = soql`SELECT Id FROM ScratchOrgInfo WHERE SignupUsername = '${escapeSOQL(username)}'`;
    const result = await this.conn.query<{Id: string}>(query);
    return result.records[0]?.Id;
  }

  async isOrgActive(username: string): Promise<boolean> {
    const query = soql`SELECT Id FROM ActiveScratchOrg WHERE SignupUsername = '${escapeSOQL(username)}'`;
    const result = await this.conn.query<{Id: string}>(query);
    return result.totalSize > 0;
  }

  async setPassword(username: string, password?: string): Promise<PasswordResult> {
    const newPassword = password ?? await generatePassword();
    await this.setUserPassword(username, newPassword);
    return {password: newPassword};
  }

  /** Update fields on a ScratchOrgInfo record. */
  async updateOrgInfo(fields: Record<string, unknown> & {Id: string}): Promise<boolean> {
    const result = await this.conn.sobject('ScratchOrgInfo').update(fields);
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

    const results = await this.conn.sobject('ScratchOrgInfo').update(updates);
    const failures = (Array.isArray(results) ? results : [results]).filter(r => !r.success);
    if (failures.length > 0 && failures.length === updates.length) {
      const errors = failures.flatMap(f => (f as {errors?: {message: string}[]}).errors?.map(e => e.message) ?? ['unknown error']);
      throw new OrgError('update', `Failed to update pool metadata on all ${failures.length} record(s): ${errors.join('; ')}`);
    }
  }

  async validate(): Promise<void> {
    const describe = await this.conn.sobject('ScratchOrgInfo').describe();

    const allocationField = describe.fields.find(f => f.name === 'Allocation_Status__c');

    if (!allocationField) {
      throw new OrgError(
        'prerequisite',
        'ScratchOrgInfo is missing the "Allocation_Status__c" custom field. '
        + 'Deploy the sfpm pool custom fields to your DevHub before running pool operations.',
      );
    }

    const picklistValues = new Set((allocationField.picklistValues ?? []).map(v => v.value));
    const missing = REQUIRED_ALLOCATION_STATUSES.filter(s => !picklistValues.has(s));

    if (missing.length > 0) {
      throw new OrgError(
        'prerequisite',
        `Allocation_Status__c is missing required picklist values: ${missing.join(', ')}. `
        + 'Update the picklist on ScratchOrgInfo in your DevHub.',
        {context: {existing: [...picklistValues], missing}},
      );
    }

    const tagField = describe.fields.find(f => f.name === 'Tag__c');
    if (!tagField) {
      throw new OrgError(
        'prerequisite',
        'ScratchOrgInfo is missing the "Tag__c" custom field. '
        + 'Deploy the sfpm pool custom fields to your DevHub before running pool operations.',
      );
    }

    const authUrlField = describe.fields.find(f => f.name === 'Auth_Url__c');
    if (!authUrlField) {
      throw new OrgError(
        'prerequisite',
        'ScratchOrgInfo is missing the "Auth_Url__c" custom field. '
        + 'Deploy the sfpm pool custom fields to your DevHub before running pool operations.',
      );
    }
  }

  private async createScratchOrg(request: ScratchOrgRequest): Promise<PoolScratchOrgCreateResult> {
    return this.hubOrg.scratchOrgCreate(request);
  }

  private async resolveActiveRecordIds(records: ScratchOrgInfoRecord[], orgs: ScratchOrg[]): Promise<void> {
    const scratchOrgInfoIds = records
    .filter(r => r.Id)
    .map(r => `'${r.Id}'`)
    .join(',');

    if (!scratchOrgInfoIds) return;

    const activeQuery = soql`SELECT Id, ScratchOrgInfoId FROM ActiveScratchOrg WHERE ScratchOrgInfoId IN (${scratchOrgInfoIds})`;
    const activeResult = await this.conn.query<{Id: string; ScratchOrgInfoId: string}>(activeQuery);

    const activeIdMap = new Map<string, string>();
    for (const record of activeResult.records) {
      activeIdMap.set(record.ScratchOrgInfoId, record.Id);
    }

    for (const [i, record] of records.entries()) {
      const infoId = record.Id;
      if (infoId && activeIdMap.has(infoId)) {
        const activeId = activeIdMap.get(infoId);
        if (activeId) {
          orgs[i].recordId = activeId;
        }
      }
    }
  }

  /** Set a password for a user via the org's SOAP API. */
  private async setUserPassword(username: string, password: string): Promise<void> {
    const scratchOrgAuthInfo = await AuthInfo.create({username});
    const scratchOrgConnection = await Org.create({
      connection: await Connection.create({authInfo: scratchOrgAuthInfo}),
    });

    const query = soql`SELECT Id FROM User WHERE Username = '${escapeSOQL(username)}'`;
    const result = await scratchOrgConnection.getConnection().query<{Id: string}>(query);

    if (result.records.length === 0) {
      throw new OrgError('password', `No user found with username ${username}`);
    }

    await scratchOrgConnection.getConnection().soap.setPassword(result.records[0].Id, password);
  }
}

function mapToScratchOrg(record: ScratchOrgInfoRecord): ScratchOrg {
  const orgId = record.ScratchOrg ?? '';
  const username = record.SignupUsername ?? '';
  const tag = record.Tag__c ?? '';
  const status = (record.Allocation_Status__c ?? undefined) as AllocationStatus;

  return {
    auth: {
      authUrl: record.Auth_Url__c,
      email: record.SignupEmail,
      loginUrl: record.LoginUrl,
      username,
    },
    expiry: record.ExpirationDate ? parseExpirationDate(record.ExpirationDate) : undefined,
    orgId,
    orgType: OrgTypes.Scratch,
    pool: {
      status,
      tag,
      timestamp: record.CreatedDate ? new Date(record.CreatedDate).getTime() : Date.now(),
    },
    recordId: record.Id,
  };
}

function parseExpirationDate(dateStr: string): number {
  const date = new Date(dateStr);
  return date.getTime();
}
