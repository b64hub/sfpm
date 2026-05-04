import {SandboxDefaults} from './org/sandbox/types.js';
import {ScratchOrgDefaults} from './org/scratch/types.js';
import {PoolConfig} from './pool/types.js';

/**
 * Org-level configuration that plugs into `sfpm.config.ts`.
 *
 * Provides project-wide defaults for org operations. Individual
 * commands can override these at invocation time.
 *
 * @example
 * ```typescript
 * // sfpm.config.ts
 * import { defineConfig } from '@b64hub/sfpm-core';
 * import { defineOrgConfig } from '@b64hub/sfpm-orgs';
 *
 * export default defineConfig({
 *   hooks: [],
 *   orgs: defineOrgConfig({
 *     scratch: {
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

  sandbox?: Partial<SandboxDefaults>;
  scratch?: Partial<ScratchOrgDefaults>;
}

/**
 * Identity function for type-safe org configuration authoring.
 *
 * @example
 * ```typescript
 * import { defineOrgConfig } from '@b64hub/sfpm-orgs';
 *
 * const orgs = defineOrgConfig({
 *   scratch: { definitionFile: 'config/project-scratch-def.json' },
 *   pool: { tag: 'dev', sizing: { maxAllocation: 10 } },
 * });
 * ```
 */
export function defineOrgConfig(config: OrgConfig): OrgConfig {
  return config;
}
