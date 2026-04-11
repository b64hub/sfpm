/**
 * Types for package.json-first workspace mode ("turbo mode").
 *
 * In this mode, each SF package directory contains a `package.json` that is
 * the source of truth for package identity, version, and dependencies.
 * `sfdx-project.json` is derived from these files via `sfpm sync`.
 *
 * The `sfpm` field in each package.json carries static configuration only:
 * package type, SF source path, API version, and deployment options.
 * Build-time metadata (apex analysis, coverage, packageVersionId) is written
 * exclusively to the artifact's package.json by the build pipeline.
 */

import type {PackageType} from './package.js';
import type {
  BuildOptions, InstallOptions, PackageHookConfig, PackageOptions,
} from './project.js';

// ---------------------------------------------------------------------------
// package.json `sfpm` field — static configuration (committed to repo)
// ---------------------------------------------------------------------------

/**
 * The `sfpm` property in a workspace member's package.json.
 *
 * Contains only **static configuration** that describes the SF package.
 * Build results (apex analysis, packageVersionId, coverage) are NOT stored here —
 * they are written to the artifact's package.json by the build pipeline.
 *
 * @example
 * ```json
 * {
 *   "name": "@myorg/core-package",
 *   "version": "1.0.0",
 *   "sfpm": {
 *     "packageType": "unlocked",
 *     "path": "force-app",
 *     "packageOptions": { "deploy": { "isTriggerAllTests": true } }
 *   }
 * }
 * ```
 */
export interface SfpmPackageConfig {
  /** Ancestor package version ID for unlocked package upgrades */
  ancestorId?: string;
  /** Ancestor version number for unlocked package upgrades */
  ancestorVersion?: string;
  /** Path to org definition file for scratch org shape */
  definitionFile?: string;
  /** Whether this unlocked package is org-dependent */
  isOrgDependent?: boolean;
  /**
   * Managed package dependencies — packages from AppExchange or other publishers.
   * Maps alias (e.g., "Nebula Logger@4.16.0") to subscriber package version ID (04t...).
   * These are NOT workspace dependencies — they are installed directly via the Tooling API.
   */
  managedDependencies?: Record<string, string>;
  /** Salesforce Package2 ID (0Ho...) for unlocked packages */
  packageId?: string;
  /** Per-package build, deploy, and hook configuration */
  packageOptions?: PackageOptions;
  /** Package type: unlocked, source, or data */
  packageType: Exclude<PackageType, 'managed'>;
  /**
   * Relative path to the Salesforce source directory within this package dir.
   * Defaults to `"."` (package root). Only set when source lives in a subdirectory
   * like `"force-app"` or `"main/default"`.
   */
  path?: string;
  /**
   * Path to seed metadata directory, resolved relative to the package directory.
   * During sync, converted to a project-relative path for sfdx-project.json.
   */
  seedMetadata?: string;
  /**
   * Path to unpackaged metadata directory, resolved relative to the package directory.
   * During sync, converted to a project-relative path for sfdx-project.json.
   */
  unpackagedMetadata?: string;
  /** Human-readable version description */
  versionDescription?: string;
}

// ---------------------------------------------------------------------------
// Workspace package.json structure
// ---------------------------------------------------------------------------

/**
 * A workspace member's package.json with SFPM extensions.
 *
 * This extends a minimal set of standard npm package.json fields with
 * the `sfpm` property for Salesforce-specific configuration.
 */
export interface WorkspacePackageJson {
  /** Any other fields the user has in their package.json */
  [key: string]: unknown;
  /** Workspace dependencies — `workspace:^x.y.z` or `workspace:*` refs to other SF packages */
  dependencies?: Record<string, string>;
  /** User-managed dev dependencies (LWC Jest, ESLint, etc.) — never touched by SFPM */
  devDependencies?: Record<string, string>;
  /** Scoped package name (e.g., "@myorg/core-package") */
  name: string;
  /** Always true for SF packages — these are not published directly to npm */
  private?: boolean;
  /** Scripts including sfpm:build, sfpm:install — user scripts preserved */
  scripts?: Record<string, string>;
  /** SFPM static configuration */
  sfpm: SfpmPackageConfig;
  /** Package version in semver format (e.g., "1.0.0") */
  version: string;
}

// ---------------------------------------------------------------------------
// Turbo configuration types
// ---------------------------------------------------------------------------

/**
 * Minimal turbo.json task definition for generation purposes.
 */
export interface TurboTaskDefinition {
  cache?: boolean;
  dependsOn?: string[];
  env?: string[];
  inputs?: string[];
  outputs?: string[];
}

/**
 * Minimal turbo.json structure for generation.
 */
export interface TurboConfig {
  $schema?: string;
  tasks: Record<string, TurboTaskDefinition>;
}

// ---------------------------------------------------------------------------
// Sync result types
// ---------------------------------------------------------------------------

/**
 * Result of a workspace sync operation.
 */
export interface WorkspaceSyncResult {
  /** Packages that were discovered and processed */
  packages: WorkspaceSyncPackage[];
  /** Path to the generated sfdx-project.json */
  sfdxProjectPath: string;
  /** Warnings encountered during sync (e.g., path resolution issues) */
  warnings: string[];
}

/**
 * Per-package info produced during sync.
 */
export interface WorkspaceSyncPackage {
  /** The resolved package name (from package.json name, stripped of scope) */
  name: string;
  /** Relative path from project root to the package directory */
  packageDir: string;
  /** The package type */
  type: Exclude<PackageType, 'managed'>;
}
