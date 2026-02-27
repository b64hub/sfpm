/**
 * Re-exports from domain-specific type modules.
 *
 * Consumers should prefer importing directly from the domain modules:
 * - `@b64/sfpm-orgs/org/types` — org-layer types (DevHub, OrgError, etc.)
 * - `@b64/sfpm-orgs/pool/types` — pool types (PoolConfig, PoolOrgProvider, etc.)
 *
 * This barrel re-export exists for backward compatibility.
 */

// Scratch org types
export type {ScratchOrg} from './org/scratch/types.js';

// Org-layer types
export type {
  AllocationStatus,
  CreateScratchOrgOptions,
  DevHub,
  JwtAuthConfig,
  OrgServiceEvents,
  PasswordResult,
  ScratchOrgCreateRequest,
  ScratchOrgCreateResult,
  ScratchOrgDefaults,
  ScratchOrgUsage,
  SendEmailOptions,
  ShareScratchOrgOptions,
} from './org/types.js';

export {DEFAULT_SCRATCH_ORG, OrgError} from './org/types.js';

// Pool-layer types
export type {
  PoolConfig,
  PoolDeleteOptions,
  PoolFetchOptions,
  PoolOrgAuthenticator,
  PoolOrgLoggerFactory,
  PoolOrgProvider,
  PoolOrgRecord,
  PoolOrgTask,
  PoolOrgTaskResult,
  PostClaimAction,
  PoolProvisioningState,
  PoolSizingConfig,
} from './pool/types.js';

export {DEFAULT_POOL_SIZING} from './pool/types.js';

// ============================================================================
// Org Configuration for sfpm.config.ts
// ============================================================================

import type {ScratchOrgDefaults} from './org/types.js';
import type {PoolConfig} from './pool/types.js';

/**
 * Org-level configuration that plugs into `sfpm.config.ts`.
 *
 * Provides project-wide defaults for org operations. Individual
 * commands can override these at invocation time.
 *
 * @example
 * ```typescript
 * // sfpm.config.ts
 * import { defineConfig } from '@b64/sfpm-core';
 * import { defineOrgConfig } from '@b64/sfpm-orgs';
 *
 * export default defineConfig({
 *   hooks: [],
 *   orgs: defineOrgConfig({
 *     scratchOrg: {
 *       definitionFile: 'config/project-scratch-def.json',
 *       expiryDays: 7,
 *     },
 *     pool: {
 *       tag: 'dev-pool',
 *       sizing: { maxAllocation: 10, minAllocation: 2 },
 *     },
 *   }),
 * });
 * ```
 */
export interface OrgConfig {
  /** Default network settings applied to all provisioned orgs */
  network?: PoolConfig['network'];

  /** Pool configuration(s). A single pool or an array of named pools. */
  pool?: PoolConfig | PoolConfig[];

  /** Default scratch org settings applied to all create operations */
  scratchOrg?: Partial<ScratchOrgDefaults>;
}

/**
 * Identity function for type-safe org configuration authoring.
 *
 * @example
 * ```typescript
 * import { defineOrgConfig } from '@b64/sfpm-orgs';
 *
 * const orgs = defineOrgConfig({
 *   scratchOrg: { definitionFile: 'config/project-scratch-def.json' },
 *   pool: { tag: 'dev', sizing: { maxAllocation: 10 } },
 * });
 * ```
 */
export function defineOrgConfig(config: OrgConfig): OrgConfig {
  return config;
}
