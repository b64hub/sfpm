import type {SandboxPoolConfig, ScratchOrgPoolConfig} from './pool/types.js';

/**
 * Pool config as written in `sfpm.config.ts`.
 *
 * `definitionFile` is optional here because it can be inherited from
 * the global `scratch` / `sandbox` defaults on `OrgConfig`.
 */
export type PoolConfigInput
  = | Omit<SandboxPoolConfig, 'definitionFile'> & {definitionFile?: string}
    | Omit<ScratchOrgPoolConfig, 'definitionFile'> & {definitionFile?: string};

/**
 * Global defaults for scratch org pools (shared across all scratch pools).
 *
 * `type` is omitted — it's implied by the property name.
 */
export type ScratchOrgDefaults = Omit<Partial<ScratchOrgPoolConfig>, 'type'>;

/**
 * Global defaults for sandbox pools (shared across all sandbox pools).
 *
 * `type` is omitted — it's implied by the property name.
 */
export type SandboxDefaults = Omit<Partial<SandboxPoolConfig>, 'type'>;

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
 *     sandbox: {
 *       definitionFile: 'config/sandbox-def.json',
 *     },
 *     pools: {
 *       dev: {
 *         type: 'scratch',
 *         sizing: { max: 10, min: 2 },
 *       },
 *     },
 *   }),
 * });
 * ```
 */
export interface OrgConfig {
  /** Pool configuration(s) keyed by tag. */
  pools?: {[tag: string]: PoolConfigInput};

  /** Global defaults for sandbox pools (type omitted — implied) */
  sandbox?: SandboxDefaults;

  /** Global defaults for scratch org pools (type omitted — implied) */
  scratch?: ScratchOrgDefaults;
}

/**
 * Identity function for type-safe org configuration authoring.
 *
 * @example
 * ```typescript
 * import { defineOrgConfig } from '@b64hub/sfpm-orgs';
 *
 * const orgs = defineOrgConfig({
 *   scratch: {
 *     definitionFile: 'config/project-scratch-def.json',
 *   },
 *   pools: {
 *     dev: {
 *       type: 'scratch',
 *       sizing: { max: 10 },
 *     },
 *   },
 * });
 * ```
 */
export function defineOrgConfig(config: OrgConfig): OrgConfig {
  return config;
}
