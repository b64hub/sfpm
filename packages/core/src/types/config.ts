import {LifecycleHooks} from './lifecycle.js';

// ============================================================================
// SFPM Configuration
// ============================================================================

/**
 * Configuration for artifact-related features.
 *
 * @example
 * ```typescript
 * // sfpm.config.ts
 * import { defineConfig } from '@b64/sfpm-core';
 *
 * export default defineConfig({
 *   artifacts: {
 *     trackHistory: true,
 *   },
 * });
 * ```
 */
export interface ArtifactsConfig {
  /**
   * When enabled, creates an `Sfpm_Artifact_History__c` record in the target org
   * each time an artifact is installed or updated.
   *
   * This is opt-in because the custom object must be deployed to the target org
   * separately (it is not part of the core SFPM package). If the object does not
   * exist in the org, history creation silently skips with a warning.
   *
   * @default false
   */
  trackHistory?: boolean;
}

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
   * Artifact-related configuration.
   * Controls optional features like history tracking in the target org.
   *
   * @example
   * ```typescript
   * artifacts: {
   *   trackHistory: true,
   * }
   * ```
   */
  artifacts?: ArtifactsConfig;

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
