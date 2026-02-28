import type {Sandbox} from './sandbox/types.js';
import type {ScratchOrg} from './scratch/types.js';

// ============================================================================
// PoolOrg — Base interface for pool-managed orgs
// ============================================================================

/**
 * The org type discriminant values.
 *
 * Defined up front so that `PoolOrg.kind` can reference it without
 * circular derivation.
 */
export type OrgType = 'sandbox' | 'scratchOrg';

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
  status: string;
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
 * - {@link ScratchOrg} — `orgType: 'scratchOrg'`
 * - {@link Sandbox}    — `orgType: 'sandbox'`, adds `pool.groupId`
 *
 * Use the `orgType` discriminant only when you genuinely need type-specific
 * behaviour.  The vast majority of pool code should depend on `PoolOrg`
 * alone.
 */
export interface PoolOrg {
  auth: PoolOrgAuth;
  expiry?: number;
  orgId: string;
  readonly orgType: OrgType;
  pool?: PoolOrgInfo;
  recordId?: string;
}

// ============================================================================
// Type Guards
// ============================================================================

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
  return org.orgType === 'sandbox';
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
  return org.orgType === 'scratchOrg';
}
