import type {NetworkSettings, SandboxPoolConfig, ScratchOrgPoolConfig} from './pool/types.js';

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
 *     pools: {
 *       'dev-pool': {
 *         type: 'scratch',
 *         definitionFile: 'config/project-scratch-def.json',
 *         sizing: { max: 10, min: 2 },
 *       },
 *     },
 *   }),
 * });
 * ```
 */
export interface OrgConfig<T extends SandboxPoolConfig | ScratchOrgPoolConfig = SandboxPoolConfig | ScratchOrgPoolConfig> {
  /** Default network settings applied to all provisioned orgs */
  network?: NetworkSettings;

  /** Pool configuration(s) keyed by tag. */
  pools?: {[tag: string]: T};
}

/**
 * Identity function for type-safe org configuration authoring.
 *
 * @example
 * ```typescript
 * import { defineOrgConfig } from '@b64hub/sfpm-orgs';
 *
 * const orgs = defineOrgConfig({
 *   pools: {
 *     'dev-pool': {
 *       type: 'scratch',
 *       definitionFile: 'config/project-scratch-def.json',
 *       sizing: { max: 10 },
 *     },
 *   },
 * });
 * ```
 */
export function defineOrgConfig(config: OrgConfig): OrgConfig {
  return config;
}
