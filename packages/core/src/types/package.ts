import {PackageManifestObject} from '@salesforce/source-deploy-retrieve';

import {ApexClasses, ApexSortedByType} from './apex.js';
import {InstallOptions} from './project.js';

export enum PackageType {Data = 'data', Diff = 'diff', Managed = 'managed', Source = 'source', Unlocked = 'unlocked'}

/**
 * Version format variants used by different consumers.
 * - `semver`:      semver with hyphen prerelease (e.g. `1.0.0-NEXT`, `1.0.0-7`)  -- npm registries, artifact paths
 * - `salesforce`: 4-part dot-separated           (e.g. `1.0.0.NEXT`, `1.0.0.7`)  -- Salesforce Packaging API
 */
export type VersionFormat = 'salesforce' | 'semver';

/**
 * Where the package code comes from for installation.
 * - `local`: Install directly from project source directory
 * - `artifact`: Install from built artifact (local or fetched from npm - resolver abstracts this)
 */
export enum InstallationSource {
  Artifact = 'artifact',
  Local = 'local',
}

/**
 * How an unlocked package will be installed.
 * Source packages always use source-deploy; this enum only applies to unlocked packages.
 * - `source-deploy`: Deploy source via metadata API
 * - `version-install`: Install package version using packageVersionId
 */
export enum InstallationMode {
  SourceDeploy = 'source-deploy',
  VersionInstall = 'version-install',
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

export interface SfpmPackageSource {
  branch?: string;
  commitSHA?: string;
  repositoryUrl?: string;
  sourceHash?: string;
  tag?: string;
}

/**
 * A container for metadata that includes a mandatory baseline of all components
 * and optional specialized categorizations found by analyzers.
 */
export interface CategorizedMetadata {
  [category: string]: string[] | undefined;
  all: string[]; // The physical truth from ComponentSet
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
  apex?: {
    [category: string]: MetadataFile[] | string[] | undefined;
    classes?: MetadataFile[];
    tests?: MetadataFile[];
  };
  fields?: CategorizedMetadata & {
    fht?: string[];
    ft?: string[];
    picklists?: string[];
  };
  metadataCount: number;
  payload?: PackageManifestObject;
  testCoverage?: number;
}

export interface SfpmPackageOrchestration {
  build?: SfpmPackageBuildOptions;
  creationDetails?: {duration?: number; timestamp?: number};
  install?: InstallOptions;
  installation?: {
    installationTime?: number;
    subDirectory?: string;
    targetOrg: string;
    timestamp?: number
  }[];
}

export interface SfpmPackageBuildOptions {
  isCoverageEnabled?: boolean;
  waitTime?: number;
}

export interface SfpmUnlockedPackageBuildOptions extends SfpmPackageBuildOptions {
  definitionFile?: string;
  installationKey?: string;
  isAsyncValidation?: boolean;
  isSkipValidation?: boolean;
  postInstallScript?: string;
}

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
  orchestration: SfpmPackageOrchestration;
  packageName: string;
  packageType: Omit<PackageType, 'managed'>;
  source: SfpmPackageSource;
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

/**
 * @deprecated
 */
export interface PackageInfo {
  apexClassesSortedByTypes?: ApexSortedByType;
  apexClassWithOutTestClasses?: ApexClasses;
  apexTestClassses?: string[];
  apextestsuite?: string;
  apiVersion?: string;
  assignPermSetsPostDeployment?: string[];
  assignPermSetsPreDeployment?: string[];
  branch?: string;
  changelogFilePath?: string;
  commitSHAFrom?: string;
  commitSHATo?: string;
  configFilePath?: string;
  creation_details?: {creation_time?: number; timestamp?: number};
  dependencies?: any;
  deployments?: {installation_time?: number; sub_directory?: string; target_org: string; timestamp?: number}[];
  destructiveChanges?: any;
  destructiveChangesPath?: string;
  has_passed_coverage_check?: boolean;
  id?: string;
  isApexFound?: boolean;
  isDependencyValidated?: boolean;
  isPayLoadContainTypesSupportedByProfiles?: boolean;
  isPermissionSetGroupFound?: boolean;
  isPickListsFound?: boolean;
  isProfilesFound?: boolean;
  isPromoted?: boolean;
  isTriggerAllTests?: boolean;
  metadataCount?: number;
  package_name: string;
  package_type?: string;
  package_version_id?: string;
  package_version_number?: string;
  packageDescriptor?: any;
  packageDirectory?: string;
  payload?: any;
  postDeploymentScript?: string;
  preDeploymentScript?: string;
  projectConfig?: any;
  reconcileProfiles?: boolean;
  repository_url?: string;
  sourceDir?: string;
  sourceVersion?: string;
  tag?: string;
  test_coverage?: number;
  triggers?: ApexClasses;
}

