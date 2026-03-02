import {OrgTypes} from '@salesforce/core';

import type {Sandbox} from './sandbox/types.js';
import type {ScratchOrg} from './scratch/types.js';

import {AllocationStatus} from './types.js';

/**
 * Authentication fields stored against a pool-managed org.
 *
 * Shared by all org types — scratch orgs and sandboxes populate the
 * same set of optional fields.
 */
export interface PoolOrgAuth {
  alias?: string;
  authUrl?: string;
  email?: string;
  loginUrl?: string;
  password?: string;
  token?: string;
  username: string;
}

/**
 * Pool metadata attached to a managed org.
 *
 * Tracks the org's allocation lifecycle inside a pool (tag, status,
 * provisioning timestamp, post-deploy script flag).
 *
 * Subtypes (e.g. `SandboxPoolInfo`) may extend this with type-specific
 * fields such as `groupId`.
 */
export interface PoolOrgInfo {
  isScriptExecuted?: boolean;
  status: AllocationStatus;
  tag: string;
  timestamp: number;
}

/**
 * Base interface for orgs managed by a pool.
 *
 * The pool layer (`PoolManager`, `PoolFetcher`, `OrgProvider`, etc.)
 * operates exclusively on `PoolOrg` — it does not know or care which
 * concrete subtype it is working with.  Org-type-specific logic lives
 * behind the `OrgProvider` interface.
 *
 * Concrete subtypes:
 * - {@link ScratchOrg} — `orgType: OrgTypes.Scratch`
 * - {@link Sandbox}    — `orgType: OrgTypes.Sandbox`, adds `pool.groupId`
 *
 * Use the `orgType` discriminant only when you genuinely need type-specific
 * behaviour.  The vast majority of pool code should depend on `PoolOrg`
 * alone.
 */
export interface PoolOrg {
  auth: PoolOrgAuth;
  expiry?: number;
  orgId: string;
  readonly orgType: OrgTypes;
  pool?: PoolOrgInfo;
  recordId?: string;
}

/**
 * Record shape for updating org pool metadata
 */
export interface PoolOrgRecord {
  allocationStatus: AllocationStatus;
  authUrl?: string;
  id: string;
  password?: string;
  poolTag: string;
}

/**
 * Pool org usage count for a single user.
 */
export interface PoolOrgUsage {
  /** Number of active scratch orgs owned by this user */
  count: number;
  /** The user's signup email address */
  email: string;
}

/**
 * Narrow a `PoolOrg` to `Sandbox`.
 *
 * @example
 * ```typescript
 * if (isSandbox(org)) {
 *   console.log(org.pool?.groupId); // safe
 * }
 * ```
 */
export function isSandbox(org: PoolOrg): org is Sandbox {
  return org.orgType === OrgTypes.Sandbox;
}

/**
 * Narrow a `PoolOrg` to `ScratchOrg`.
 *
 * @example
 * ```typescript
 * if (isScratchOrg(org)) {
 *   // scratch-org-specific handling
 * }
 * ```
 */
export function isScratchOrg(org: PoolOrg): org is ScratchOrg {
  return org.orgType === OrgTypes.Scratch;
}
