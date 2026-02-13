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
 * @example
 * ```typescript
 * // sfpm.config.ts
 * import { defineConfig } from '@b64/sfpm-core';
 * import { profileHooks } from '@b64/sfpm-profiles';
 *
 * export default defineConfig({
 *   hooks: [
 *     profileHooks({ reconcile: true }),
 *   ],
 * });
 * ```
 */
export interface SfpmConfig {
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
