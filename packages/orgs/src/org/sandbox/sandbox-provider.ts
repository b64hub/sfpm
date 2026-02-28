import {escapeSOQL, soql} from '@b64/sfpm-core';
import {Org} from '@salesforce/core';
import {Duration} from '@salesforce/kit';

import type {PoolOrgRecord} from '../../pool/types.js';
import type {OrgCreateOptions, OrgProvider} from '../org-provider.js';
import type {PoolOrg} from '../pool-org.js';
import type {AllocationStatus, PasswordResult} from '../types.js';
import type {Sandbox} from './types.js';

import {OrgError} from '../types.js';
import {DEFAULT_SANDBOX} from './types.js';

// ============================================================================
// Record types — raw Salesforce SObject shapes
// ============================================================================

/**
 * Raw SandboxInfo record shape as returned from SOQL queries.
 *
 * Standard fields plus custom pool fields (`Tag__c`, `Allocation_Status__c`,
 * `Auth_Url__c`) that must be deployed to the production org.
 */
export interface SandboxInfoRecord {
  Allocation_Status__c?: string;
  Auth_Url__c?: string;
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
  Tag__c?: string;
}

// ============================================================================
// Constants
// ============================================================================

const SANDBOX_INFO_FIELDS: (keyof SandboxInfoRecord)[] = [
  'Allocation_Status__c',
  'Auth_Url__c',
  'AutoActivate',
  'CreatedDate',
  'EndDate',
  'Id',
  'LicenseType',
  'SandboxName',
  'SandboxOrganization',
  'Status',
  'Tag__c',
];

const REQUIRED_ALLOCATION_STATUSES: AllocationStatus[] = [
  'Allocate',
  'Assigned',
  'Available',
  'In Progress',
  'Return',
];

// ============================================================================
// SandboxProvider
// ============================================================================

/**
 * Provider for managing sandboxes in a pool.
 *
 * Uses the `@salesforce/core` SDK's `Org.createSandbox()`, `Org.cloneSandbox()`,
 * and sandbox query methods — never creates `SandboxInfo` records directly.
 * Custom pool fields (`Tag__c`, `Allocation_Status__c`, `Auth_Url__c`) are
 * updated via SOQL/DML on `SandboxInfo` after the SDK handles lifecycle.
 *
 * The hub org must be a **production org** with sandbox licenses.
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
export default class SandboxProvider implements OrgProvider {
  private readonly conn;
  private readonly hubOrg;
  private readonly hubUsername: string;

  constructor(hubOrg: Org) {
    this.conn = hubOrg.getConnection();
    this.hubOrg = hubOrg;
    this.hubUsername = hubOrg.getUsername() ?? '';
  }

  // ==========================================================================
  // OrgProvider — Pool operations
  // ==========================================================================

  async claimOrg(id: string): Promise<boolean> {
    try {
      const result = await this.conn.sobject('SandboxInfo').update({
        Allocation_Status__c: 'Allocate' as const, // eslint-disable-line camelcase -- Salesforce custom field
        Id: id,
      });
      return result.success === true;
    } catch {
      return false;
    }
  }

  async createOrg(options: OrgCreateOptions): Promise<PoolOrg> {
    const sandboxName = options.sandboxName ?? options.alias;
    const licenseType = options.licenseType ?? DEFAULT_SANDBOX.licenseType;
    const waitMinutes = options.waitMinutes ?? DEFAULT_SANDBOX.waitMinutes;

    const sandboxRequest = {
      ActivationUserGroupId: options.activationUserGroupId,
      ApexClassId: options.apexClassId,
      LicenseType: licenseType,
      SandboxName: sandboxName,
    };

    let processResult;

    if (options.sourceSandboxName) {
      // Clone from an existing sandbox using the proper SDK API
      processResult = await this.hubOrg.cloneSandbox(
        sandboxRequest,
        options.sourceSandboxName,
        {
          interval: Duration.seconds(30),
          wait: Duration.minutes(waitMinutes),
        },
      );
    } else {
      // Create a new sandbox using the proper SDK API
      processResult = await this.hubOrg.createSandbox(
        sandboxRequest,
        {
          async: false,
          interval: Duration.seconds(30),
          wait: Duration.minutes(waitMinutes),
        },
      );
    }

    const orgId = processResult.SandboxOrganization ?? '';

    // Derive the sandbox username (production username + sandbox name suffix)
    const sandboxUsername = orgId
      ? await this.resolveSandboxUsername(sandboxName)
      : '';

    const sandbox: Sandbox = {
      auth: {
        alias: options.alias,
        loginUrl: 'https://test.salesforce.com',
        username: sandboxUsername,
      },
      orgId,
      orgType: 'sandbox',
      pool: {
        groupId: options.activationUserGroupId,
        status: 'In Progress',
        tag: '',
        timestamp: Date.now(),
      },
    };

    return sandbox;
  }

  async deleteOrgs(recordIds: string[]): Promise<void> {
    for (const recordId of recordIds) {
      try {
        // Look up the sandbox to get its name, then use SDK to delete
        // eslint-disable-next-line no-await-in-loop
        const sandboxInfo = await this.conn.sobject('SandboxInfo').retrieve(recordId) as {Id: string; SandboxName: string};
        if (sandboxInfo?.SandboxName) {
          // eslint-disable-next-line no-await-in-loop
          const process = await this.hubOrg.querySandboxProcessBySandboxName(sandboxInfo.SandboxName);
          if (process?.SandboxOrganization) {
            // eslint-disable-next-line no-await-in-loop
            const sandboxOrg = await Org.create({aliasOrUsername: process.SandboxOrganization});
            // eslint-disable-next-line no-await-in-loop
            await sandboxOrg.deleteFrom(this.hubOrg);
          }
        }
      } catch {
        // If SDK deletion fails, fall back to destroying the SandboxInfo record
        // eslint-disable-next-line no-await-in-loop
        await this.conn.sobject('SandboxInfo').destroy(recordId);
      }
    }
  }

  async generatePassword(_username: string): Promise<PasswordResult> {
    // Sandboxes inherit the production user's password.
    // No password generation needed for pool-fetched sandboxes.
    return {password: undefined};
  }

  async getActiveCountByTag(tag: string): Promise<number> {
    const query = soql`SELECT count() FROM SandboxInfo WHERE Tag__c = '${escapeSOQL(tag)}' AND Status = 'Active'`;
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

    const query = soql`SELECT ${SANDBOX_INFO_FIELDS.join(', ')} FROM SandboxInfo WHERE ${conditions.join(' AND ')} ORDER BY CreatedDate DESC`;
    const result = await this.conn.query<SandboxInfoRecord>(query);
    return result.records.map(r => mapToSandbox(r));
  }

  async getOrgsByTag(tag: string, myPool?: boolean): Promise<PoolOrg[]> {
    const conditions = [
      `Tag__c = '${escapeSOQL(tag)}'`,
    ];

    if (myPool) {
      conditions.push(`CreatedById = '${escapeSOQL(this.hubUsername)}'`);
    }

    const query = soql`SELECT ${SANDBOX_INFO_FIELDS.join(', ')} FROM SandboxInfo WHERE ${conditions.join(' AND ')} ORDER BY CreatedDate DESC`;
    const result = await this.conn.query<SandboxInfoRecord>(query);
    return result.records.map(r => mapToSandbox(r));
  }

  async getRecordIds(orgs: PoolOrg[]): Promise<PoolOrg[]> {
    if (orgs.length === 0) return orgs;

    // For sandboxes, the SandboxInfo Id IS the record Id — already populated
    // from the query. But if missing, look up by sandbox org ID.
    const missingIds = orgs.filter(org => !org.recordId && org.orgId);
    if (missingIds.length === 0) return orgs;

    const orgIdList = missingIds.map(org => `'${escapeSOQL(org.orgId)}'`).join(',');
    const query = soql`SELECT Id, SandboxOrganization FROM SandboxInfo WHERE SandboxOrganization IN (${orgIdList})`;
    const result = await this.conn.query<{Id: string; SandboxOrganization: string}>(query);

    const idMap = new Map<string, string>();
    for (const record of result.records) {
      if (record.SandboxOrganization) {
        idMap.set(record.SandboxOrganization, record.Id);
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

  getUsername(): string {
    return this.hubUsername;
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

  async updatePoolMetadata(records: PoolOrgRecord[]): Promise<void> {
    if (records.length === 0) return;

    const updates = records.map(r => ({
      Allocation_Status__c: r.allocationStatus, // eslint-disable-line camelcase -- Salesforce custom field
      Id: r.id,
      Tag__c: r.poolTag, // eslint-disable-line camelcase -- Salesforce custom field
    }));

    await this.conn.sobject('SandboxInfo').update(updates);
  }

  async validate(): Promise<void> {
    const describe = await this.conn.sobject('SandboxInfo').describe();

    const tagField = describe.fields.find(f => f.name === 'Tag__c');
    if (!tagField) {
      throw new OrgError(
        'prerequisite',
        'SandboxInfo is missing the "Tag__c" custom field. '
        + 'Deploy the sfpm pool custom fields to your production org before running sandbox pool operations.',
      );
    }

    const allocationField = describe.fields.find(f => f.name === 'Allocation_Status__c');
    if (!allocationField) {
      throw new OrgError(
        'prerequisite',
        'SandboxInfo is missing the "Allocation_Status__c" custom field. '
        + 'Deploy the sfpm pool custom fields to your production org before running sandbox pool operations.',
      );
    }

    const picklistValues = new Set((allocationField.picklistValues ?? []).map(v => v.value));
    const missing = REQUIRED_ALLOCATION_STATUSES.filter(s => !picklistValues.has(s));

    if (missing.length > 0) {
      throw new OrgError(
        'prerequisite',
        `Allocation_Status__c on SandboxInfo is missing required picklist values: ${missing.join(', ')}. `
        + 'Update the picklist on SandboxInfo in your production org.',
        {context: {existing: [...picklistValues], missing}},
      );
    }

    const authUrlField = describe.fields.find(f => f.name === 'Auth_Url__c');
    if (!authUrlField) {
      throw new OrgError(
        'prerequisite',
        'SandboxInfo is missing the "Auth_Url__c" custom field. '
        + 'Deploy the sfpm pool custom fields to your production org before running sandbox pool operations.',
      );
    }
  }

  // ==========================================================================
  // Private helpers
  // ==========================================================================

  /**
   * Extract the sandbox name suffix from a username.
   *
   * Salesforce sandbox usernames follow the pattern `user@example.com.sandboxname`.
   */
  private extractSandboxName(username: string): string | undefined {
    const parts = username.split('.');
    return parts.length > 2 ? parts.at(-1) : undefined;
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
// Internal helpers
// ============================================================================

/** Map a SandboxInfo SOQL record to the domain `Sandbox` type. */
function mapToSandbox(record: SandboxInfoRecord): Sandbox {
  const orgId = record.SandboxOrganization ?? '';
  const sandboxName = record.SandboxName ?? '';
  const tag = record.Tag__c ?? '';
  const status = record.Allocation_Status__c ?? '';

  return {
    auth: {
      authUrl: record.Auth_Url__c,
      loginUrl: 'https://test.salesforce.com',
      username: sandboxName ? `${sandboxName}` : '',
    },
    expiry: record.EndDate ? new Date(record.EndDate).getTime() : undefined,
    orgId,
    orgType: 'sandbox',
    pool: {
      status,
      tag,
      timestamp: record.CreatedDate ? new Date(record.CreatedDate).getTime() : Date.now(),
    },
    recordId: record.Id,
  };
}
