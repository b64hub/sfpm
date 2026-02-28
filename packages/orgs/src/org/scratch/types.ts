import type {PoolOrg} from '../pool-org.js';

/**
 * A scratch org managed by a pool.
 *
 * Extends `PoolOrg` with a fixed `kind` discriminant.  Scratch orgs
 * share the same pool metadata shape as the base — no additional
 * fields are needed.
 */
export interface ScratchOrg extends PoolOrg {
  readonly orgType: 'scratchOrg';
}

/**
 * Pool-level options for creating a scratch org.
 *
 * Used by `ScratchOrgProvider.createOrg()`. Maps to `ScratchOrgCreateRequest`
 * internally but uses pool-friendly terminology (e.g., `expiryDays` instead
 * of `durationDays`).
 */
export interface ScratchOrgCreateOptions {
  /** Local alias for the scratch org */
  alias: string;
  /** Path to the scratch org definition file */
  definitionFile: string;
  /** Number of days until the org expires */
  expiryDays?: number;
  /** Whether to exclude ancestor versions */
  noAncestors?: boolean;
  /** Max retries on transient failures */
  retries?: number;
  /** Max minutes to wait for creation */
  waitMinutes?: number;
}

/**
 * SDK-level configuration for creating a scratch org.
 *
 * @internal
 */
export interface ScratchOrgCreateRequest {
  /** Local alias for the scratch org */
  alias: string;
  /** Path to the scratch org definition file */
  definitionFile: string;
  /** Number of days until the org expires */
  durationDays: number;
  /** Whether to exclude ancestor versions */
  noAncestors?: boolean;
  /** Whether to exclude namespace from the org */
  noNamespace?: boolean;
  /** Number of retries on transient failures */
  retries?: number;
  /** Max minutes to wait for org creation */
  waitMinutes?: number;
}

/**
 * Result returned from the hub after scratch org creation.
 */
export interface ScratchOrgCreateResult {
  loginUrl: string;
  orgId: string;
  username: string;
  warnings?: string[];
}

/**
 * Scratch org usage count for a single user.
 *
 * Returned by `DevHub.getScratchOrgUsageByUser()`. Maps to
 * the `SELECT count(id) In_Use, SignupEmail FROM ActiveScratchOrg
 * GROUP BY SignupEmail` aggregate query.
 */
export interface ScratchOrgUsage {
  /** Number of active scratch orgs owned by this user */
  count: number;
  /** The user's signup email address */
  email: string;
}

/**
 * Scratch org creation defaults used when provisioning orgs for a pool.
 *
 * These settings control how individual scratch orgs are created.
 * They can be overridden per-invocation via `CreateScratchOrgOptions`.
 */
export interface ScratchOrgDefaults {
  /** Path to the scratch org definition file (e.g., `config/project-scratch-def.json`) */
  definitionFile: string;
  /** Number of days until scratch orgs expire (default: 7) */
  expiryDays?: number;
  /** Max retries on transient creation failures (default: 3) */
  maxRetries?: number;
  /** Whether to exclude ancestor package versions (default: false) */
  noAncestors?: boolean;
  /** Max minutes to wait for org creation (default: 6) */
  waitMinutes?: number;
}

/** Default scratch org creation settings. */
export const DEFAULT_SCRATCH_ORG: Required<Pick<ScratchOrgDefaults, 'expiryDays' | 'maxRetries' | 'noAncestors' | 'waitMinutes'>> = {
  expiryDays: 7,
  maxRetries: 3,
  noAncestors: false,
  waitMinutes: 6,
};
