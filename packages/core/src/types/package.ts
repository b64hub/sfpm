import type {ArtifactResolutionOptions, SfpmPackageSource} from './artifact.js';

import {DependencyAnalyzer} from './dependency-analysis.js';
import {ValidationLevel} from './validation.js';

/**
 * Salesforce test levels for metadata API deployments.
 *
 * Mirrors the `testLevel` values accepted by the Salesforce Metadata API
 * and `@salesforce/source-deploy-retrieve`
 */
export type TestLevel = 'NoTestRun' | 'RunAllTestsInOrg' | 'RunLocalTests' | 'RunRelevantTests' | 'RunSpecifiedTests';

export enum PackageType {Data = 'data', Diff = 'diff', Managed = 'managed', Source = 'source', Unlocked = 'unlocked'}

/**
 * Version format variants used by different consumers.
 * - `semver`:      semver with hyphen prerelease (e.g. `1.0.0-NEXT`, `1.0.0-7`)  -- npm registries, artifact paths
 * - `salesforce`: 4-part dot-separated           (e.g. `1.0.0.NEXT`, `1.0.0.7`)  -- Salesforce Packaging API
 */
export type VersionFormat = 'salesforce' | 'semver';

/**
 * Where the package code comes from for installation.
 * - `local`: Install from built ./dist
 * - `artifact`: Install from node_modules
 */
export const enum PackageOrigin {
  Artifact = 'artifact',
  Local = 'local',
}

export interface BuildOptions {
  /** Build number for version generation */
  buildNumber?: string;
  /** Target org for source package validation (deploy + test) */
  buildOrg?: string;
  /**
   * Pluggable dependency analyzer for cross-package reference validation.
   * Must be initialized before passing to the builder.
   * When provided and `validation` includes analysis, violations are reported.
   */
  dependencyAnalyzer?: DependencyAnalyzer;
  /** Force build even if no source changes detected (skip hash check) */
  force?: boolean;
  /** DevHub username or alias for unlocked package builds */

  /** Path to a .forceignore file for controlling which files are included in the build output */
  ignoreFile?: string;

  unlocked?: UnlockedBuildOptions;
  /**
   * Validation level. Controls which quality gates run during the build.
   *
   * - `full`  — static analysis + org validation (default)
   * - `org`   — org validation only (skip static analysis)
   * - `local` — static analysis only (no org connection)
   * - `none`  — assemble only
   */
  validation?: ValidationLevel;
  /** Timeout in minutes for package version creation (default: 120) */
  waitTime?: number;
}

export interface UnlockedBuildOptions {
  definitionFile?: string;
  devhubUsername?: string;
  installationKey?: string;
  /**
   * Unlocked packages are built as source instead of creating a package version.
   * No DevHub required. Designed for PR validation against scratch orgs.
   */
  sourceOnly?: boolean;
}

export interface InstallOptions {
  artifactResolution?: Omit<ArtifactResolutionOptions, 'version'>;
  /** Force reinstall even if already installed with matching version/hash */
  force?: boolean;
  /** Path to a .forceignore file for controlling which files are deployed */
  ignoreFile?: string;
  /**
   * Where to install from: 'local' (project source ./dist) or 'artifact' (installed node_modules).
   */
  origin?: PackageOrigin;
  testLevel?: TestLevel;
  unlocked?: UnlockedInstallOptions;
  /** Update sfpm artifact records in org upon installation */
  updateArtifact?: boolean;
  waitTime?: number
}

export interface UnlockedInstallOptions {
  /** Installation key for unlocked packages */
  installationKey?: string;
  /**
   * Unlocked packages are deployed as source instead of installing a package version.
   */
  sourceOnly?: boolean;
}

export type MetadataFile = string | {
  name: string;
  path?: string;
}

export interface SfpmPackageIdentity {
  apiVersion?: string;
  packageName: string;
  packageType: Omit<PackageType, 'managed'>; // Managed packages are only for subscriber orgs, not sfpm artifacts
  versionNumber?: string;
}

/** @deprecated Use top-level fields on SfpmUnlockedPackageMetadata instead */
export interface SfpmUnlockedPackageIdentity extends SfpmPackageIdentity {
  isOrgDependent: boolean;
  packageId?: string;
  packageType: PackageType.Unlocked;
  packageVersionId?: string;
}

/**
 * A container for metadata that includes a mandatory baseline of all components
 * and optional specialized categorizations found by analyzers.
 */
export interface CategorizedMetadata {
  [category: string]: MetadataFile[] | string[] | undefined;
}

/**
 * Package content metadata written to the artifact.
 *
 * Most component-level detail (flows, profiles, permission sets, etc.) is
 * already captured by the MDAPI manifest `payload`. This interface holds
 * only the **additive analysis** that the payload does not provide:
 *   - Apex class/test classification
 *   - Field-level categorisation (FHT, FT, picklists)
 */
export interface SfpmPackageContent {
  [key: string]: any;
  apex?: CategorizedMetadata & {
    classes?: MetadataFile[];
    tests?: MetadataFile[];
  };
  fields?: CategorizedMetadata & {
    fht?: string[];
    ft?: string[];
    picklists?: string[];
  };
  metadataCount: number;
  testCoverage?: number;
}

/**
 * Per-package build configuration from project config (package.json / sfdx-project.json).
 * These are static settings that travel with the package definition, not runtime build params.
 */
export interface PerPackageBuildConfig {
  /** Scratch org definition file for unlocked package builds */
  definitionFile?: string;
  /** Installation key for the package version */
  installationKey?: string;
  /** Post-install Apex script class name */
  postInstallScript?: string;
}

// ============================================================================
// Data Package Content
// ============================================================================

/**
 * Content descriptor for data packages.
 * Intentionally separate from SfpmPackageContent — data packages have no
 * Salesforce metadata components, apex, or manifests.
 */
export interface SfpmDataPackageContent {
  /** Relative path to the data directory within the package (from packageDefinition.path) */
  dataDirectory: string;
  /** Total number of files in the data directory */
  fileCount: number;
}

// ---------------------------------------------------------------------------
// Package Metadata Hierarchy
//
//   SfpmPackageMetadataBase         (universal: identity fields, orchestration, source)
//     ├── SfpmPackageMetadata       (source/unlocked: + content)
//     │     └── SfpmUnlockedPackageMetadata (+ packageId, packageVersionId, isOrgDependent)
//     └── SfpmDataPackageMetadata   (data: + data-specific content)
// ---------------------------------------------------------------------------

/**
 * Base metadata shared by **all** package types (source, unlocked, data, …).
 * Identity fields (packageName, packageType, etc.) live at the top level.
 */
export interface SfpmPackageMetadataBase {
  [key: string]: any;
  apiVersion?: string;
  // package name without npm scope. This is used for user-facing messages and Salesforce operations, but should not be used as a unique identifier since it is not guaranteed to be unique across scopes.
  packageName: string;
  packageType: Omit<PackageType, 'managed'>;
  // npm scope of the package, if present. This is not guaranteed to be unique across packages, and should not be used as an identifier on its own. It is primarily for informational purposes and to reconstruct the fully qualified package name when needed. For Salesforce operations, the scope is stripped and only the unscoped package name is used.
  readonly scope: string;
  source?: SfpmPackageSource;
  versionNumber?: string;
}

/**
 * Metadata for source and unlocked packages.
 * Adds Salesforce-specific content (apex analysis, field categorisation, manifest).
 */
export interface SfpmPackageMetadata extends SfpmPackageMetadataBase {
  content: SfpmPackageContent;
}

export interface SfpmUnlockedPackageMetadata extends SfpmPackageMetadata {
  isOrgDependent: boolean;
  packageId?: string;
  packageType: PackageType.Unlocked;
  packageVersionId?: string;
}

/**
 * Metadata for data packages.
 * Contains data-specific content with no Salesforce metadata components.
 */
export interface SfpmDataPackageMetadata extends SfpmPackageMetadataBase {
  content: SfpmDataPackageContent;
}

/**
 * Represents merged view of sfpm artifacts + subscriber packages
 */
export interface InstalledArtifact {
  checksum?: string;
  commitId?: string;
  isInstalledBySfpm?: boolean;
  isOrgDependent?: boolean;
  name: string;
  sourceVersion?: string;
  subscriberVersionId?: string;
  tag?: string;
  type?: PackageType
  version: string;
}

