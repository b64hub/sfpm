import {z} from 'zod';

import type {PackageType} from './package.js';

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
  build?: BuildOptions;
  deploy?: DeployOptions;
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
export interface DeployOptions {
  isTriggerAllTests?: boolean;
  optimize?: boolean;
  post?: {
    destructiveChanges?: string;
    unpackagedMetadata?: {path: string};
  }
  pre?: {
    destructiveChanges?: string;
    unpackagedMetadata?: {path: string};
  },
  testLevel?: string;
}

// ---------------------------------------------------------------------------
// Package dependency
// ---------------------------------------------------------------------------

/**
 * A single dependency reference within a package's dependency array.
 * Represents either an internal workspace dependency (with versionNumber)
 * or a managed external dependency (without versionNumber, resolved via packageAliases).
 */
export interface PackageDependency {
  /** Package name (scope-stripped for internal, full alias for managed). */
  package: string;
  /** Salesforce version number (e.g., "1.0.0.LATEST"). Absent for managed deps. */
  versionNumber?: string;
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
  // -- Core identity --------------------------------------------------------

  /** Salesforce package name (scope-stripped, e.g., "core-package"). */
  package: string; 
  /** Relative path from project root to the source directory (e.g., "packages/core/force-app"). */
  path: string;
  /** Salesforce version number (e.g., "1.2.0.NEXT"). */
  versionNumber: string;

  // -- Classification -------------------------------------------------------

  /** Whether this is the default package directory. */
  default?: boolean;
  /** Package type: unlocked, source, or data. Defaults to unlocked when unset. */
  type?: PackageType;

  // -- SFPM extensions ------------------------------------------------------

  /** Full npm-scoped name from workspace package.json (e.g., "@myorg/core-package"). */
  npmName?: string;
  /** Salesforce Package2 ID (0Ho prefix). */
  packageId?: string;
  /** Per-package build, deploy, and hook configuration. */
  packageOptions?: PackageOptions;

  // -- SF packaging fields --------------------------------------------------

  /** Ancestor package version ID for unlocked packages. */
  ancestorId?: string;
  /** Ancestor version number for unlocked packages. */
  ancestorVersion?: string;
  /** Path to scratch org definition file. */
  definitionFile?: string;
  /** Whether this is an org-dependent unlocked package. */
  isOrgDependent?: boolean;
  /** Whether to scope profiles to this package directory only. */
  scopeProfiles?: boolean;
  /** Description for the package version. */
  versionDescription?: string;

  // -- Metadata paths -------------------------------------------------------

  /** Relative path to the seed metadata directory. */
  seedMetadata?: string;
  /** Relative path to the unpackaged metadata directory. */
  unpackagedMetadata?: string;

  // -- Dependencies ---------------------------------------------------------

  /** Package dependencies (both internal workspace and managed external). */
  dependencies?: PackageDependency[];
}

/**
 * Represents an external/managed package dependency that is not part of the
 * project's packageDirectories. These are packages (e.g. Nebula Logger) that
 * are referenced as dependencies but whose source is not in the project.
 *
 * Managed dependencies are identified by:
 * - Being listed in a package's `dependencies` array without a `versionNumber`
 * - Having a corresponding `packageAliases` entry that resolves to a
 *   subscriber package version ID (04t prefix)
 * - Having NO entry in `packageDirectories` (no local path)
 */
export interface ManagedPackageDefinition {
  /** The full package reference as it appears in dependencies and aliases (e.g. "Nebula Logger@4.16.0") */
  package: string;
  /** The subscriber package version ID (starts with 04t) resolved from packageAliases */
  packageVersionId: string;
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
  packageDirectories: PackageDefinition[];
  /** Map of package aliases to their IDs (0Ho Package2 IDs or 04t subscriber version IDs). */
  packageAliases?: Record<string, string>;
  /** Salesforce namespace (empty string for no namespace). */
  namespace?: string;
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

export const PackageDependencySchema = z.object({
  package: z.string(),
  versionNumber: z.string().optional(),
});

export const PackageDefinitionSchema = z.object({
  package: z.string(),
  path: z.string(),
  versionNumber: z.string(),
  default: z.boolean().optional(),
  type: z.string().optional(),
  npmName: z.string().optional(),
  packageId: z.string().optional(),
  packageOptions: z.object({
    build: z.object({
      asyncValidation: z.boolean().optional(),
      skipValidation: z.boolean().optional(),
    }).passthrough().optional(),
    deploy: z.object({
      optimize: z.boolean().optional(),
      isTriggerAllTests: z.boolean().optional(),
      testLevel: z.string().optional(),
      post: z.object({
        destructiveChanges: z.string().optional(),
        unpackagedMetadata: z.object({path: z.string()}).optional(),
      }).optional(),
      pre: z.object({
        destructiveChanges: z.string().optional(),
        unpackagedMetadata: z.object({path: z.string()}).optional(),
      }).optional(),
    }).optional(),
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
    skip: z.array(z.string()).optional(),
  }).passthrough().optional(),
  ancestorId: z.string().optional(),
  ancestorVersion: z.string().optional(),
  definitionFile: z.string().optional(),
  isOrgDependent: z.boolean().optional(),
  scopeProfiles: z.boolean().optional(),
  versionDescription: z.string().optional(),
  seedMetadata: z.string().optional(),
  unpackagedMetadata: z.string().optional(),
  dependencies: z.array(PackageDependencySchema).optional(),
}).passthrough();

export const ProjectDefinitionSchema = z.object({
  packageDirectories: z.array(PackageDefinitionSchema),
  packageAliases: z.record(z.string(), z.string()).optional(),
  namespace: z.string().optional(),
  sfdcLoginUrl: z.string().optional(),
  sourceApiVersion: z.string().optional(),
  sourceBehaviorOptions: z.array(z.string()).optional(),
}).passthrough();

