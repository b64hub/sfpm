import {OrgTypes, type ScratchOrgCreateResult, type ScratchOrgInfo} from '@salesforce/core';

import type {PoolOrg} from '../pool-org.js';

export type {
  AuthFields, OrgTypes, ScratchOrgCreateResult, ScratchOrgInfo, ScratchOrgRequest,
} from '@salesforce/core';

/**
 * A scratch org managed by a pool.
 *
 * Extends `PoolOrg` with a fixed `kind` discriminant.  Scratch orgs
 * share the same pool metadata shape as the base — no additional
 * fields are needed.
 */
export interface ScratchOrg extends PoolOrg {
  readonly orgType: OrgTypes.Scratch;
}

/**
 * ScratchOrgInfo record with pool-specific custom fields.
 *
 * Extends the SDK's `ScratchOrgInfo` type with DevHub custom fields
 * required for pool operations (`Tag__c`, `Allocation_Status__c`, `Auth_Url__c`).
 */
export interface ScratchOrgInfoRecord extends ScratchOrgInfo {
  Allocation_Status__c?: string;
  Auth_Url__c?: string;
  Tag__c?: string;
}

/**
 * SDK `ScratchOrgCreateResult` narrowed so that `scratchOrgInfo`
 * includes our pool-specific custom fields.
 *
 * The DevHub returns these fields at runtime — this type makes them
 * visible to TypeScript without redefining the entire SDK result.
 */
export type PoolScratchOrgCreateResult = Omit<ScratchOrgCreateResult, 'scratchOrgInfo'> & {
  scratchOrgInfo?: ScratchOrgInfoRecord;
};

/** Default scratch org creation settings. */
export const DEFAULT_SCRATCH_ORG = {
  expiryDays: 7,
  maxRetries: 3,
  noAncestors: false,
  waitMinutes: 6,
};
