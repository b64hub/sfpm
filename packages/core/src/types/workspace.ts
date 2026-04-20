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
  BuildOptions, DeployOptions, PackageDir, PackageHookConfig, PackageOptions,
} from './project.js';

// ---------------------------------------------------------------------------
// package.json `sfpm` field — static configuration (committed to repo)
// ---------------------------------------------------------------------------

/**
 * The named package variant of PackageDir (the one with `package` and `versionNumber`).
 * PackageDir is a union of a simple `{path}` variant and a full package variant;
 * Extract narrows to the variant that carries SF packaging fields like
 * `ancestorId`, `definitionFile`, `seedMetadata`, etc.
 */
type NamedPackageDir = Extract<PackageDir, {package: string; versionNumber: string}>;

/**
 * The `sfpm` property in a workspace member's package.json.
 *
 * Contains only **static configuration** that describes the SF package.
 * Build results (apex analysis, packageVersionId, coverage) are NOT stored here —
 * they are written to the artifact's package.json by the build pipeline.
 *
 * Extends the named PackageDir variant (which carries SF packaging fields like
 * `ancestorId`, `definitionFile`, `seedMetadata`, `unpackagedMetadata`, etc.),
 * omitting fields that are managed by the package.json itself (`package`,
 * `versionNumber`) or overridden with SFPM semantics (`path`).
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
export interface SfpmPackageConfig extends Omit<NamedPackageDir, 'package' | 'path' | 'seedMetadata' | 'unpackagedMetadata' | 'versionNumber'> {
  isOrgDependent?: boolean;
  /** Salesforce package ID (0Ho prefix) resolved from packageAliases */
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
  /** Relative path to the seed metadata directory (resolved to `{path}` object during sync) */
  seedMetadata?: string;
  /** Relative path to the unpackaged metadata directory (resolved to `{path}` object during sync) */
  unpackagedMetadata?: string;
}

// ---------------------------------------------------------------------------
// Package.json hierarchy
//
// SfpmPackageJson<TSfpm>          Generic base for all SFPM package.json variants
//   ├── WorkspacePackageJson      Committed to repo — sfpm contains static config only
//   └── NpmPackageJson            Generated during build — sfpm adds build metadata
//                                 (defined in npm.ts)
// ---------------------------------------------------------------------------

/**
 * Base package.json structure shared between workspace (repo) and artifact (npm).
 *
 * Generic over the `sfpm` property type so the same standard npm fields are
 * defined once. The workspace variant carries only static configuration;
 * the artifact variant adds build-time metadata via intersection.
 *
 * @typeParam TSfpm - Shape of the `sfpm` property. Defaults to `SfpmPackageConfig`
 *   (static configuration only, as stored in the repo).
 */
export interface SfpmPackageJson<TSfpm extends SfpmPackageConfig = SfpmPackageConfig> {
  /** Any other fields the user has in their package.json */
  [key: string]: unknown;
  author?: string;
  bugs?: {
    url: string;
  };

  /** Workspace dependencies — `workspace:^x.y.z` or `workspace:*` refs to other SF packages */
  dependencies?: Record<string, string>;
  description?: string;
  /** User-managed dev dependencies (LWC Jest, ESLint, etc.) — never touched by SFPM */
  devDependencies?: Record<string, string>;
  /** Package keywords for discovery */
  keywords?: string[];
  /** License identifier */
  license?: string;
  /**
   * Managed package dependencies — packages from AppExchange or other publishers.
   * Maps alias (e.g., "Nebula Logger@4.16.0") to subscriber package version ID (04t...).
   * These are NOT workspace dependencies — they are installed directly via the Tooling API.
   */
  managedDependencies?: Record<string, string>;
  /** Scoped package name (e.g., "@myorg/core-package") */
  name: string;
  /** Always true for SF packages — these are not published directly to npm */
  private?: boolean;
  /** Scripts including sfpm:build, sfpm:install — user scripts preserved */
  scripts?: Record<string, string>;
  /** SFPM-specific metadata — static config in the workspace, enriched with build metadata in artifacts */
  sfpm: TSfpm;
  /** Package version in semver format (e.g., "1.0.0") */
  version: string;
}

/**
 * A workspace member's package.json (committed to the repo).
 *
 * The `sfpm` property contains only static configuration (`SfpmPackageConfig`).
 * Build-time metadata is added later by the artifact assembly pipeline and
 * stored in the artifact's `NpmPackageJson`.
 */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface WorkspacePackageJson extends SfpmPackageJson<SfpmPackageConfig> {}

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
