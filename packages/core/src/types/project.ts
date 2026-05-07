import {z} from 'zod';

import {PackageType} from './package.js';

/** Salesforce key prefix for subscriber package version IDs */
export const SUBSCRIBER_PKG_VERSION_ID_PREFIX = '04t';

/**
 * Merge mode for env-aliased packages.
 * - `union`: env directory contents are merged on top of the default directory (env wins conflicts)
 * - `disjoint`: only the env directory is used, default is ignored entirely
 */
export type EnvAliasMode = 'disjoint' | 'union';

/**
 * Configuration for environment-aliased packages.
 * When a package is env-aliased, it contains subdirectories for each target environment
 * plus a mandatory `default/` directory. At install/deploy time, the target org alias
 * is matched against subdirectory names to select the correct metadata variant.
 */
export interface EnvAliasConfig {
  /** Merge mode: 'union' overlays env on default, 'disjoint' uses env only. Default: 'union' */
  mode?: EnvAliasMode;
}

// Orchestration options
export interface PackageOptions {
  [key: string]: any;
  /** Whether this is the default package directory. */
  build?: BuildOptions;
  /**
   * Marks this package as environment-aliased.
   * When `true`, uses default config (union mode).
   * When an object, allows specifying the merge mode.
   */
  envAliased?: boolean | EnvAliasConfig;
  /**
   * Per-package hook configuration.
   *
   * Keys are hook names (matching `LifecycleHooks.name`). Values control
   * whether the hook runs for this package and provide hook-specific overrides.
   *
   * Use `false` as shorthand to disable a hook entirely:
   * ```json
   * { "hooks": { "profiles": false } }
   * ```
   *
   * Use an object to override specific settings:
   * ```json
   * { "hooks": { "permission-set": { "post": ["AdminPermSet"] } } }
   * ```
   *
   * Hooks not listed here use their global defaults from `sfpm.config.ts`.
   */
  hooks?: Record<string, boolean | PackageHookConfig>;
  ignore?: string[];
  install?: PackageInstallConfig;
  skip?: string[];
  validate?: any;
}

export interface BuildOptions {
  asyncValidation?: boolean;
  skipValidation?: boolean;
}

/**
 * Per-package override for a single lifecycle hook.
 *
 * Placed under `packageOptions.hooks[hookName]` in `sfdx-project.json`.
 * Each hook defines its own config shape — the only universal field is
 * `enabled`, which controls whether the hook runs for this package.
 *
 * @example
 * ```json
 * {
 *   "packageOptions": {
 *     "hooks": {
 *       "permission-set": { "post": ["AdminPermSet"] },
 *       "profiles": false,
 *       "flow-activation": { "enabled": true, "skipAlreadyActive": true }
 *     }
 *   }
 * }
 * ```
 */
export interface PackageHookConfig {
  /** Hook-specific configuration — each hook defines its own shape. */
  [key: string]: unknown;
  /** Whether this hook should run for this package. Defaults to `true`. */
  enabled?: boolean;
}

/**
 * Build and deployment configuration for a package.
 *
 * Controls build-time and deploy-time behavior that is not hook-specific:
 * script assembly, optimized deployment, etc.
 */
export interface PackageInstallConfig {
  isTriggerAllTests?: boolean;
  optimize?: boolean;
  post?: {
    destructiveChanges?: string;
    unpackagedMetadata?: string;
  }
  pre?: {
    destructiveChanges?: string;
    unpackagedMetadata?: string;
  },
  testLevel?: string;
}

// ---------------------------------------------------------------------------
// Package definition
// ---------------------------------------------------------------------------

/**
 * Versioned package directory entry with SFPM extensions.
 *
 * This is the canonical SFPM type for a package directory — fully decoupled
 * from @salesforce/core's PackageDir union. Providers map their backing
 * format (sfdx-project.json or workspace package.json) into this shape.
 */
export interface PackageDefinition {
  /** Whether this package is the default package. */
  default?: boolean;
  /** Package dependencies with version constraints (e.g., { "core": "^1.0.0", "apex-utils": "2.2.0" }) */
  dependencies?: {[packageName: string]: string};
  /** Package description */
  description?: string;
  /** Managed package dependencies with version Id (e.g., { "nebula-logger": "04tXXXXXXXXXXXX" }) */
  managedDependencies?: {[packageName: string]: string};
  /** Metadata dependencies with relative paths (e.g., { "seed": "path/to/seed", "unpackaged": "path/to/unpackaged" }) */
  metadataDependencies?: {
    seed: string;
    unpackaged: string;
  }
  /** package name (including scope). */
  name: string;
  /** Salesforce namespace (empty string for no namespace). */
  namespace?: string;
  /** Salesforce Package2 ID (0Ho prefix). */
  packageId?: string;
  /** Per-package build, deploy, and hook configuration. */
  packageOptions?: PackageOptions;

  /** Relative path from project root to the source directory (e.g., "packages/core/force-app"). */
  path: string;
  /** Package type: unlocked, source, or data. Defaults to unlocked when unset. */
  type: PackageType;
  /** semver version number (e.g., "1.2.0"). */
  version: string;
}

// ---------------------------------------------------------------------------
// Project definition
// ---------------------------------------------------------------------------

/**
 * Full project definition, analogous to sfdx-project.json but SFPM-owned.
 *
 * Decoupled from @salesforce/core's ProjectJson — providers map their backing
 * format into this canonical shape.
 */
export interface ProjectDefinition {
  /** The list of package directories in this project. */
  packages: PackageDefinition[];
  /** Login URL for the Salesforce org. */
  sfdcLoginUrl?: string;
  /** Source API version (e.g., "63.0"). */
  sourceApiVersion?: string;
  /** Source tracking behavior options. */
  sourceBehaviorOptions?: string[];
}

// ---------------------------------------------------------------------------
// Zod schemas (standalone — no @salesforce/core dependency)
// ---------------------------------------------------------------------------

export const PackageDefinitionSchema = z.object({
  default: z.boolean().optional(),
  dependencies: z.record(z.string(), z.string()).optional(),
  description: z.string().optional(),
  managedDependencies: z.record(z.string(), z.string()).optional(),
  metadataDependencies: z.object({
    seed: z.string(),
    unpackaged: z.string(),
  }).optional(),
  name: z.string(),
  namespace: z.string().optional(),
  packageId: z.string().optional(),
  packageOptions: z.object({
    build: z.object({
      asyncValidation: z.boolean().optional(),
      skipValidation: z.boolean().optional(),
    }).passthrough().optional(),
    envAliased: z.union([
      z.boolean(),
      z.object({
        mode: z.enum(['union', 'disjoint']).optional(),
      }),
    ]).optional(),
    hooks: z.record(
      z.string(),
      z.union([z.boolean(), z.record(z.string(), z.unknown())]),
    ).optional(),
    ignore: z.array(z.string()).optional(),
    install: z.object({
      isTriggerAllTests: z.boolean().optional(),
      optimize: z.boolean().optional(),
      post: z.object({
        destructiveChanges: z.string().optional(),
        unpackagedMetadata: z.string().optional(),
      }).optional(),
      pre: z.object({
        destructiveChanges: z.string().optional(),
        unpackagedMetadata: z.string().optional(),
      }).optional(),
      testLevel: z.string().optional(),
    }).optional(),
    skip: z.array(z.string()).optional(),
  }).passthrough().optional(),
  path: z.string(),
  type: z.nativeEnum(PackageType),
  version: z.string(),
}).passthrough();

export const ProjectDefinitionSchema = z.object({
  packages: z.array(PackageDefinitionSchema),
  sfdcLoginUrl: z.string().optional(),
  sourceApiVersion: z.string().optional(),
  sourceBehaviorOptions: z.array(z.string()).optional(),
}).passthrough();

