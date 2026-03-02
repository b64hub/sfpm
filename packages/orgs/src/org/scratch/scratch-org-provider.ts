import {escapeSOQL, soql} from '@b64/sfpm-core';
import {
  AuthInfo, Connection, Org, OrgTypes, StateAggregator,
} from '@salesforce/core';
import {Duration} from '@salesforce/kit';

import type {OrgProvider} from '../org-provider.js';
import type {PoolOrg, PoolOrgUsage, PoolOrgRecord} from '../pool-org.js';
import {
  AllocationStatus, PasswordResult
} from '../types.js';

import generatePassword from '../../utils/password-generator.js';
import setAlias from '../../utils/set-alias.js';
import {OrgError} from '../types.js';
import {
  type ScratchOrg, type ScratchOrgCreateOptions, ScratchOrgCreateRequest, ScratchOrgCreateResult,
} from './types.js';

/**
 * Raw ScratchOrgInfo record shape as returned from SOQL queries.
 *
 * Field names match the Salesforce `ScratchOrgInfo` SObject.
 * Custom fields (`Tag__c`, `Allocation_Status__c`, `Password__c`,
 * `Auth_Url__c`) are DevHub customizations required for pool operations.
 */
export interface ScratchOrgInfoRecord {
  Allocation_Status__c?: string;
  Auth_Url__c?: string;
  CreatedDate?: string;
  ExpirationDate?: string;
  Id?: string;
  LoginUrl?: string;
  ScratchOrg?: string;
  SignupEmail?: string;
  SignupUsername?: string;
  Status?: string;
  Tag__c?: string;
}

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
 * Provider for managing scratch orgs in a pool.
 *
 * Queries `ScratchOrgInfo` and `ActiveScratchOrg` SObjects in the DevHub.
 * Creates scratch orgs via `Org.scratchOrgCreate()`.
 *
 * Also provides DevHub-level utilities (email, alias, JWT config) that
 * are shared across providers but naturally live on the hub org.
 */
export default class ScratchOrgProvider implements OrgProvider<ScratchOrgCreateOptions> {
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

  async createOrg(options: ScratchOrgCreateOptions): Promise<PoolOrg> {
    const request: ScratchOrgCreateRequest = {
      alias: options.alias,
      definitionFile: options.definitionFile,
      durationDays: options.expiryDays ?? 7,
      noAncestors: options.noAncestors,
      noNamespace: false,
      retries: options.retries ?? 0,
      waitMinutes: options.waitMinutes ?? 6,
    };

    const result = await this.createScratchOrg(request);

    await setAlias(result.username, options.alias);

    const scratchOrg: ScratchOrg = {
      auth: {
        alias: options.alias,
        loginUrl: result.loginUrl,
        username: result.username,
      },
      orgId: result.orgId,
      orgType: OrgTypes.Scratch,
    };

    const passwordResult = await this.setPassword(scratchOrg.auth.username);
    if (passwordResult.password) {
      scratchOrg.auth.password = passwordResult.password;
    }

    return scratchOrg;
  }

  async deleteOrgs(recordIds: string[]): Promise<void> {
    for (const recordId of recordIds) {
      // eslint-disable-next-line no-await-in-loop -- sequential deletion avoids overwhelming the API
      await this.conn.sobject('ActiveScratchOrg').destroy(recordId);
    }
  }

  async setPassword(username: string, password?: string): Promise<PasswordResult> {
    const newPassword = password ?? await generatePassword();
    await this.setUserPassword(username, newPassword);
    return {password: newPassword};
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
      String.raw`(Allocation_Status__c = 'Available' OR Allocation_Status__c = 'In Progress')`,
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

    const orgIdMap = new Map<string, PoolOrg>();
    for (const org of orgs) {
      if (org.orgId) {
        const shortId = org.orgId.slice(0, 15);
        orgIdMap.set(shortId, org);
      }
    }

    const idList = [...orgIdMap.keys()].map(id => `'${id}'`).join(',');
    const query = soql`SELECT Id, ScratchOrg FROM ScratchOrgInfo WHERE ScratchOrg IN (${idList})`;
    const result = await this.conn.query<{Id: string; ScratchOrg: string}>(query);

    for (const record of result.records) {
      const org = orgIdMap.get(record.ScratchOrg);
      if (org) {
        org.recordId = record.Id;
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

  /** Update fields on a ScratchOrgInfo record. */
  async updateOrgInfo(fields: Record<string, unknown> & {Id: string}): Promise<boolean> {
    const result = await this.conn.sobject('ScratchOrgInfo').update(fields);
    return result.success === true;
  }

  async updatePoolMetadata(records: PoolOrgRecord[]): Promise<void> {
    if (records.length === 0) return;

    const updates = records.map(r => ({
      Allocation_Status__c: r.allocationStatus, // eslint-disable-line camelcase -- Salesforce custom field
      Id: r.id,
      Password__c: r.password, // eslint-disable-line camelcase -- Salesforce custom field
      Tag__c: r.poolTag, // eslint-disable-line camelcase -- Salesforce custom field
    }));

    await this.conn.sobject('ScratchOrgInfo').update(updates);
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
  }


  private async createScratchOrg(request: ScratchOrgCreateRequest): Promise<ScratchOrgCreateResult> {
    const result = await this.hubOrg.scratchOrgCreate({
      definitionfile: request.definitionFile,
      durationDays: request.durationDays,
      noancestors: request.noAncestors,
      nonamespace: request.noNamespace,
      retry: request.retries ?? 0,
      wait: Duration.minutes(request.waitMinutes ?? 6),
    });

    return {
      loginUrl: result.authFields?.loginUrl ?? result.authFields?.instanceUrl ?? '',
      orgId: result.authFields?.orgId ?? '',
      username: result.username ?? '',
      warnings: result.warnings,
    };
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
}

function mapToScratchOrg(record: ScratchOrgInfoRecord): ScratchOrg {
  const orgId = record.ScratchOrg ?? '';
  const username = record.SignupUsername ?? '';
  const tag = record.Tag__c ?? '';
  const status = record.Allocation_Status__c ?? '';

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
