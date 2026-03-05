import {LifecycleHooks} from './lifecycle.js';

// ============================================================================
// SFPM Configuration
// ============================================================================

/**
 * Stage-specific .forceignore file mappings.
 * Each stage can have a custom ignore file for fine-grained control
 * over which metadata is included during that lifecycle phase.
 */
export interface IgnoreFilesConfig {
  /** Ignore file for production builds */
  build?: string;
  /** Ignore file for prepare/staging phase */
  prepare?: string;
  /** Ignore file for quick builds (no validation) */
  quickbuild?: string;
  /** Ignore file for validation builds */
  validate?: string;
}

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
 * import { defineConfig } from '@b64/sfpm-core';
 * import { defineOrgConfig } from '@b64/sfpm-orgs';
 * import { profileHooks } from '@b64/sfpm-hooks';
 *
 * export default defineConfig({
 *   npmScope: '@myorg',
 *   hooks: [
 *     profileHooks({ scope: 'source' }),
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

  /**
   * Stage-specific .forceignore files.
   * Configure different ignore patterns for different lifecycle stages.
   *
   * @example
   * ```typescript
   * ignoreFiles: {
   *   build: '.forceignore.build',
   *   validate: '.forceignore.validate',
   * }
   * ```
   */
  ignoreFiles?: IgnoreFilesConfig;

  /**
   * npm scope for publishing packages (e.g., '@myorg').
   * Required for npm registry integration and artifact publishing.
   *
   * @example '@myorg'
   */
  npmScope?: string;
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
