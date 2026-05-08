import {OrgTypes, SandboxInfo} from '@salesforce/core';

import type {PoolOrg, PoolOrgInfo} from '../pool-org.js';

/**
 * Pool metadata for a sandbox, extending the base with sandbox-specific fields.
 */
export interface SandboxPoolInfo extends PoolOrgInfo {
  /** Group whose members may access this sandbox. */
  groupId?: string;
}

/**
 * A sandbox managed by a pool.
 *
 * Extends `PoolOrg` with a fixed `kind` discriminant and a richer
 * `pool` shape that includes `groupId`.
 */
export interface Sandbox extends PoolOrg {
  readonly orgType: OrgTypes.Sandbox;
  pool?: SandboxPoolInfo;
}

/**
 * Sandbox license types supported by Salesforce.
 *
 * Maps to the `LicenseType` field on `SandboxInfo`.
 */
export type SandboxLicenseType = SandboxInfo['LicenseType'];

/** Default sandbox pool operation settings. */
export const DEFAULT_SANDBOX = {
  maxRetries: 3,
  waitMinutes: 30,
};

/**
 * Pool-level options for creating a sandbox.
 *
 * Used by `SandboxProvider.createOrg()`. The provider reads the
 * definition file, resolves the sandbox name from `namePattern`
 * or the definition's `sandboxName`, and builds the SDK request.
 */
export interface SandboxCreateOptions {
  /** Local alias for the sandbox (e.g., SB1, SB2) */
  alias: string;
  /** Path to the sandbox definition file */
  definitionFile: string;
  /** Override for the sandbox name prefix from the definition file */
  namePattern?: string;
  /** Max minutes to wait for creation */
  waitMinutes?: number;
}
