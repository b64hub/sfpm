import {LifecycleHooks} from './lifecycle.js';

// ============================================================================
// SFPM Configuration
// ============================================================================

/**
 * SFPM tooling configuration loaded from `sfpm.config.ts` (or `.js` / `.mjs`).
 *
 * This is separate from the `plugins.sfpm` section in `sfdx-project.json`,
 * which handles Salesforce-project-level settings (npmScope, ignoreFiles).
 * The config file is for SFPM tooling concerns: lifecycle hooks, task
 * configuration, and settings that benefit from programmatic control.
 *
 * The index signature allows module packages (orgs, profiles, etc.) to
 * register their own config sections without core depending on them.
 * Each module provides a typed `define*Config()` helper for type safety.
 *
 * @example
 * ```typescript
 * // sfpm.config.ts
 * import { defineConfig } from '@b64/sfpm-core';
 * import { defineOrgConfig } from '@b64/sfpm-orgs';
 * import { profileHooks } from '@b64/sfpm-profiles';
 *
 * export default defineConfig({
 *   hooks: [
 *     profileHooks({ reconcile: true }),
 *   ],
 *   orgs: defineOrgConfig({
 *     scratchOrg: { definitionFile: 'config/project-scratch-def.json' },
 *   }),
 * });
 * ```
 */
export interface SfpmConfig {
  /**
   * Module-specific configuration sections.
   * Modules like `@b64/sfpm-orgs` register their config under a named key
   * (e.g., `orgs`). Use the module's `define*Config()` helper for type safety.
   */
  [key: string]: unknown;

  /**
   * Lifecycle hooks to activate.
   * Hooks participate in lifecycle phases (build, install, etc.) to add
   * cross-cutting behavior like profile cleaning, data loading, etc.
   */
  hooks?: LifecycleHooks[];
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
 * import { defineConfig } from '@b64/sfpm-core';
 *
 * export default defineConfig({
 *   hooks: [],
 * });
 * ```
 */
export function defineConfig(config: SfpmConfig): SfpmConfig {
  return config;
}
