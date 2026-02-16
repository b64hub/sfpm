import {escapeSOQL, soql} from '@b64/sfpm-core';
import {AuthInfo, Org, StateAggregator} from '@salesforce/core';
import {Duration} from '@salesforce/kit';

import type {
  AllocationStatus,
  DevHub,
  JwtAuthConfig,
  PasswordResult,
  PoolInfoProvider,
  PoolOrgRecord,
  PoolOrgSource,
  PoolPrerequisiteChecker,
  ScratchOrgCreateRequest,
  ScratchOrgCreateResult,
  ScratchOrgUsage,
  SendEmailOptions,
} from '../../types.js';
import type {ScratchOrg} from '../scratch/types.js';

// ============================================================================
// Record types – raw Salesforce SObject shapes
// ============================================================================

/**
 * Raw ScratchOrgInfo record shape as returned from SOQL queries.
 *
 * Field names match the Salesforce `ScratchOrgInfo` SObject.
 * Custom fields (`Pooltag__c`, `Allocation_status__c`, `Password__c`,
 * `SfdxAuthUrl__c`) are DevHub customizations required for pool operations.
 */
export interface ScratchOrgInfoRecord {
  Allocation_status__c?: string;
  CreatedDate?: string;
  ExpirationDate?: string;
  Id?: string;
  LoginUrl?: string;
  Password__c?: string;
  Pooltag__c?: string;
  ScratchOrg?: string;
  SfdxAuthUrl__c?: string;
  SignupEmail?: string;
  SignupUsername?: string;
  Status?: string;
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

// ============================================================================
// Constants
// ============================================================================

/**
 * Standard set of ScratchOrgInfo fields queried for pool operations.
 *
 * Used to build SOQL SELECT clauses consistently across all queries.
 */
const SCRATCH_ORG_INFO_FIELDS = [
  'Allocation_status__c',
  'CreatedDate',
  'ExpirationDate',
  'Id',
  'LoginUrl',
  'Password__c',
  'Pooltag__c',
  'ScratchOrg',
  'SfdxAuthUrl__c',
  'SignupEmail',
  'SignupUsername',
].join(', ');

/** Required picklist values on `ScratchOrgInfo.Allocation_status__c`. */
const REQUIRED_ALLOCATION_STATUSES: AllocationStatus[] = [
  'Allocate',
  'Assigned',
  'Available',
  'In Progress',
  'Return',
];

// ============================================================================
// DevHubService
// ============================================================================

/**
 * Service that wraps a Salesforce DevHub `Org` to implement all hub-level
 * operations: scratch org lifecycle, pool queries, and pool prerequisites.
 *
 * Uses composition — holds a reference to the `Org` and delegates to
 * `@salesforce/core` APIs. Consumers never extend or subclass `Org`.
 *
 * @example
 * ```ts
 * import { Org } from '@salesforce/core';
 * import { DevHubService, OrgService, PoolManager } from '@b64/sfpm-orgs';
 *
 * const org = await Org.create({ aliasOrUsername: 'my-devhub' });
 * const devHub = new DevHubService(org);
 *
 * // Use as DevHub
 * const service = new OrgService(devHub, logger);
 *
 * // Use as pool interfaces
 * const manager = new PoolManager({
 *   orgService: service,
 *   poolInfo: devHub,
 *   poolOrgSource: devHub,
 * });
 *
 * // Validate prerequisites
 * await devHub.validate();
 * ```
 */
export default class DevHubService
implements DevHub, PoolInfoProvider, PoolOrgSource, PoolPrerequisiteChecker {
  private readonly conn;
  private readonly hubOrg;
  private readonly hubUsername: string;

  constructor(hubOrg: Org) {
    this.conn = hubOrg.getConnection();
    this.hubOrg = hubOrg;
    this.hubUsername = hubOrg.getUsername() ?? '';
  }

  // ==========================================================================
  // DevHub
  // ==========================================================================

  async claimOrg(id: string): Promise<boolean> {
    try {
      const result = await this.conn.sobject('ScratchOrgInfo').update({
        Allocation_status__c: 'Allocate' as const, // eslint-disable-line camelcase -- Salesforce custom field
        Id: id,
      });

      return result.success === true;
    } catch {
      // Optimistic concurrency: if someone else already claimed it, we get a failure
      return false;
    }
  }

  async createScratchOrg(request: ScratchOrgCreateRequest): Promise<ScratchOrgCreateResult> {
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

  async deleteActiveScratchOrgs(recordIds: string[]): Promise<void> {
    for (const recordId of recordIds) {
      // eslint-disable-next-line no-await-in-loop -- sequential deletion avoids overwhelming the API
      await this.conn.sobject('ActiveScratchOrg').destroy(recordId);
    }
  }

  async generatePassword(username: string): Promise<PasswordResult> {
    const password = await (await import('../../utils/password-generator.js')).generatePassword();
    await this.setUserPassword(username, password);
    return {password};
  }

  async getActiveCountByTag(tag: string): Promise<number> {
    const query = soql`SELECT count() FROM ScratchOrgInfo WHERE Pooltag__c = '${escapeSOQL(tag)}' AND Status = 'Active'`;
    const result = await this.conn.query(query);
    return result.totalSize;
  }

  async getAvailableByTag(tag: string, myPool?: boolean): Promise<ScratchOrg[]> {
    const escapedTag = escapeSOQL(tag);
    const conditions = [
      `Pooltag__c = '${escapedTag}'`,
      'Status = \'Active\'',
      String.raw`(Allocation_status__c = 'Available' OR Allocation_status__c = 'In Progress')`,
    ];

    if (myPool) {
      conditions.push(`CreatedById = '${escapeSOQL(this.hubUsername)}'`);
    }

    const query = soql`SELECT ${SCRATCH_ORG_INFO_FIELDS} FROM ScratchOrgInfo WHERE ${conditions.join(' AND ')} ORDER BY CreatedDate DESC`;
    const result = await this.conn.query<ScratchOrgInfoRecord>(query);
    return result.records.map(r => mapToScratchOrg(r));
  }

  getJwtConfig(): JwtAuthConfig {
    const fields = this.conn.getAuthInfoFields();
    return {
      clientId: fields.clientId ?? '',
      loginUrl: fields.loginUrl,
      privateKeyPath: fields.privateKey ?? '',
    };
  }

  async getOrgsByTag(tag: string, myPool?: boolean): Promise<ScratchOrg[]> {
    let query = soql`SELECT ${SCRATCH_ORG_INFO_FIELDS} FROM ScratchOrgInfo WHERE Pooltag__c = '${escapeSOQL(tag)}' AND Status = 'Active'`;

    if (myPool) {
      query += ` AND CreatedById = '${escapeSOQL(this.hubUsername)}'`;
    }

    query += ' ORDER BY CreatedDate DESC';

    const result = await this.conn.query<ScratchOrgInfoRecord>(query);
    const orgs = result.records.map(r => mapToScratchOrg(r));

    // Resolve ActiveScratchOrg record IDs for deletion support
    if (orgs.length > 0) {
      await this.resolveActiveRecordIds(result.records, orgs);
    }

    return orgs;
  }

  async getOrphanedScratchOrgs(): Promise<ScratchOrg[]> {
    const query = soql`SELECT ${SCRATCH_ORG_INFO_FIELDS} FROM ScratchOrgInfo WHERE Pooltag__c = null AND Status = 'Active' ORDER BY CreatedDate DESC`;
    const result = await this.conn.query<ScratchOrgInfoRecord>(query);
    return result.records.map(r => mapToScratchOrg(r));
  }

  async getRecordIds(scratchOrgs: ScratchOrg[]): Promise<ScratchOrg[]> {
    if (scratchOrgs.length === 0) return scratchOrgs;

    // Truncate orgIds to 15 chars (Salesforce convention for matching)
    const orgIdMap = new Map<string, ScratchOrg>();
    for (const org of scratchOrgs) {
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

    return scratchOrgs;
  }

  async getRemainingCapacity(): Promise<number> {
    const apiVersion = this.conn.getApiVersion();
    const limits = await this.conn.request<Record<string, {Max: number; Remaining: number}>>(`/services/data/v${apiVersion}/limits`);

    return limits.ActiveScratchOrgs?.Remaining ?? 0;
  }

  // ==========================================================================
  // PoolInfoProvider
  // ==========================================================================

  async getScratchOrgInfoByUsername(username: string): Promise<string | undefined> {
    const query = soql`SELECT Id FROM ScratchOrgInfo WHERE SignupUsername = '${escapeSOQL(username)}'`;
    const result = await this.conn.query<{Id: string}>(query);
    return result.records[0]?.Id;
  }

  async getScratchOrgUsageByUser(): Promise<ScratchOrgUsage[]> {
    const query = soql`SELECT count(Id) In_Use, SignupEmail FROM ActiveScratchOrg GROUP BY SignupEmail ORDER BY count(Id) DESC`;
    const result = await this.conn.query<{In_Use: number; SignupEmail: string}>(query);
    return result.records.map(r => ({
      count: r.In_Use,
      email: r.SignupEmail,
    }));
  }

  async getUserEmail(username: string): Promise<string> {
    const query = soql`SELECT Email FROM User WHERE Username = '${escapeSOQL(username)}'`;

    return retry(async () => {
      const result = await this.conn.query<{Email: string}>(query);

      if (result.records.length === 0) {
        throw new (await import('../../types.js')).OrgError(
          'fetch',
          `No user found with username ${username} in the DevHub.`,
        );
      }

      return result.records[0].Email;
    }, 3, 3000);
  }

  getUsername(): string {
    return this.hubUsername;
  }

  async isOrgActive(username: string): Promise<boolean> {
    const query = soql`SELECT Id FROM ActiveScratchOrg WHERE SignupUsername = '${escapeSOQL(username)}'`;
    const result = await this.conn.query<{Id: string}>(query);
    return result.totalSize > 0;
  }

  async sendEmail(options: SendEmailOptions): Promise<void> {
    const apiVersion = this.conn.getApiVersion();
    await this.conn.request({
      body: JSON.stringify({
        inputs: [{
          emailAddresses: options.to,
          emailBody: options.body,
          emailSubject: options.subject,
        }],
      }),
      method: 'POST',
      url: `/services/data/v${apiVersion}/actions/standard/emailSimple`,
    });
  }

  // ==========================================================================
  // PoolOrgSource
  // ==========================================================================

  async setAlias(username: string, alias: string): Promise<void> {
    const stateAggregator = await StateAggregator.getInstance();
    await stateAggregator.aliases.setAndSave(alias, username);
  }

  async setUserPassword(username: string, password: string): Promise<void> {
    const scratchOrgAuthInfo = await AuthInfo.create({username});
    const scratchOrgConnection = await Org.create({
      connection: await (await import('@salesforce/core')).Connection.create({authInfo: scratchOrgAuthInfo}),
    });

    // Query the user ID and use SOAP API to set password
    const query = soql`SELECT Id FROM User WHERE Username = '${escapeSOQL(username)}'`;
    const result = await scratchOrgConnection.getConnection().query<{Id: string}>(query);

    if (result.records.length === 0) {
      throw new (await import('../../types.js')).OrgError(
        'password',
        `No user found with username ${username}`,
      );
    }

    await scratchOrgConnection.getConnection().soap.setPassword(result.records[0].Id, password);
  }

  async updatePoolMetadata(records: PoolOrgRecord[]): Promise<void> {
    if (records.length === 0) return;

    const updates = records.map(r => ({
      Allocation_status__c: r.allocationStatus, // eslint-disable-line camelcase -- Salesforce custom field
      Id: r.id,
      Password__c: r.password, // eslint-disable-line camelcase -- Salesforce custom field
      Pooltag__c: r.poolTag, // eslint-disable-line camelcase -- Salesforce custom field
    }));

    await this.conn.sobject('ScratchOrgInfo').update(updates);
  }

  async updateScratchOrgInfo(fields: Record<string, unknown> & {Id: string}): Promise<boolean> {
    const result = await this.conn.sobject('ScratchOrgInfo').update(fields);
    return result.success === true;
  }

  // ==========================================================================
  // PoolPrerequisiteChecker
  // ==========================================================================

  async validate(): Promise<void> {
    const describe = await this.conn.sobject('ScratchOrgInfo').describe();

    const allocationField = describe.fields.find(f => f.name === 'Allocation_status__c');

    if (!allocationField) {
      throw new (await import('../../types.js')).OrgError(
        'prerequisite',
        'ScratchOrgInfo is missing the "Allocation_status__c" custom field. '
        + 'Deploy the sfpm pool custom fields to your DevHub before running pool operations.',
      );
    }

    const picklistValues = new Set((allocationField.picklistValues ?? []).map(v => v.value));

    const missing = REQUIRED_ALLOCATION_STATUSES.filter(s => !picklistValues.has(s));

    if (missing.length > 0) {
      throw new (await import('../../types.js')).OrgError(
        'prerequisite',
        `Allocation_status__c is missing required picklist values: ${missing.join(', ')}. `
        + 'Update the picklist on ScratchOrgInfo in your DevHub.',
        {context: {existing: [...picklistValues], missing}},
      );
    }
  }

  // ==========================================================================
  // Private helpers
  // ==========================================================================

  /**
   * Enrich a list of `ScratchOrg` objects with their ActiveScratchOrg record IDs.
   */
  private async resolveActiveRecordIds(
    records: ScratchOrgInfoRecord[],
    orgs: ScratchOrg[],
  ): Promise<void> {
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
        orgs[i].recordId = activeIdMap.get(infoId);
      }
    }
  }
}

// ============================================================================
// Internal helpers
// ============================================================================

/** Map a ScratchOrgInfo SOQL record to the domain `ScratchOrg` type. */
function mapToScratchOrg(record: ScratchOrgInfoRecord): ScratchOrg {
  return {
    expiryDate: record.ExpirationDate,
    loginURL: record.LoginUrl,
    orgId: record.ScratchOrg,
    password: record.Password__c,
    recordId: record.Id,
    sfdxAuthUrl: record.SfdxAuthUrl__c,
    signupEmail: record.SignupEmail,
    status: record.Allocation_status__c,
    tag: record.Pooltag__c,
    username: record.SignupUsername,
  };
}

async function retry<T>(fn: () => Promise<T>, retries: number, delayMs: number): Promise<T> {
  let lastError: unknown;

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      // eslint-disable-next-line no-await-in-loop -- sequential retry by design
      return await fn();
    } catch (error) {
      lastError = error;
      if (attempt < retries) {
        // eslint-disable-next-line no-await-in-loop -- intentional delay between retries
        await new Promise(resolve => {
          setTimeout(resolve, delayMs);
        });
      }
    }
  }

  throw lastError;
}
