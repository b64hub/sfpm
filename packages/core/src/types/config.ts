import {LifecycleHooks} from './lifecycle.js';

// ============================================================================
// SFPM Configuration
// ============================================================================

/**
 * SFPM tooling configuration loaded from `sfpm.config.ts` (or `.js` / `.mjs`).
 *
 * This is the central configuration file for SFPM tooling concerns:
 * npm registry settings, lifecycle hooks, ignore files, and module-specific
 * configuration sections.
 *
 * The index signature allows module packages (orgs, profiles, etc.) to
 * register their own config sections without core depending on them.
 * Each module provides a typed `define*Config()` helper for type safety.
 *
 * @example
 * ```typescript
 * // sfpm.config.ts
 * import { defineConfig } from '@b64hub/sfpm-core';
 * import { defineOrgConfig } from '@b64hub/sfpm-orgs';
 * import { profileHooks } from '@b64hub/sfpm-hooks';
 *
 * export default defineConfig({
 *   hooks: [
 *     profileHooks({ scope: 'source' }),
 *   ],
 *   orgs: defineOrgConfig({
 *     scratch: { definitionFile: 'config/project-scratch-def.json' },
 *   }),
 * });
 * ```
 */
export interface SfpmConfig {
  /**
   * Module-specific configuration sections.
   * Modules like `@b64hub/sfpm-orgs` register their config under a named key
   * (e.g., `orgs`). Use the module's `define*Config()` helper for type safety.
   */
  [key: string]: unknown;

  /**
   * Lifecycle hooks to activate.
   * Hooks participate in lifecycle phases (build, install, etc.) to add
   * cross-cutting behavior like profile cleaning, data loading, etc.
   */
  hooks?: LifecycleHooks[];

  /**
   * Salesforce namespace prefix for the project.
   * Written to sfdx-project.json during sync.
   * Use empty string for no namespace.
   *
   * @example 'myns'
   */
  namespace?: string;

  /**
   * Salesforce login URL for the project.
   * Written to sfdx-project.json during sync.
   *
   * @default 'https://login.salesforce.com'
   * @example 'https://test.salesforce.com'
   */
  sfdcLoginUrl?: string;

  /**
   * Source API version for the project (e.g., '63.0').
   * Written to sfdx-project.json during sync.
   *
   * @example '63.0'
   */
  sourceApiVersion?: string;

  /**
   * Source behavior options for the project.
   * Written to sfdx-project.json during sync.
   * Controls source decomposition and other behavior presets.
   *
   * @see https://github.com/forcedotcom/source-deploy-retrieve/tree/main/src/registry/presets
   * @example ['decomposeCustomLabelsBeta']
   */
  sourceBehaviorOptions?: string[];
}

// ============================================================================
// defineConfig Helper
// ============================================================================

/**
 * Identity function that provides type-safe configuration authoring.
 *
 * This is the recommended way to define `sfpm.config.ts` — it enables
 * autocomplete and type checking without any runtime behavior.
 *
 * @example
 * ```typescript
 * // sfpm.config.ts
 * import { defineConfig } from '@b64hub/sfpm-core';
 *
 * export default defineConfig({
 *   hooks: [],
 * });
 * ```
 */
export function defineConfig(config: SfpmConfig): SfpmConfig {
  return config;
}
