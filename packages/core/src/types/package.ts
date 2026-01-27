import { PackageManifestObject } from "@salesforce/source-deploy-retrieve";
import { ApexClasses, ApexSortedByType } from "./apex.js";
import { DeploymentOptions } from "./project.js";

export enum PackageType { Unlocked = 'unlocked', Source = 'source', Data = 'data', Diff = 'diff', Managed = 'managed' }

export type MetadataFile = string | {
    name: string;
    path?: string;
}

export interface SfpmPackageIdentity {
    packageName: string;
    versionNumber?: string;
    packageType: Omit<PackageType, 'managed'>;
    apiVersion?: string;
}

export interface SfpmUnlockedPackageIdentity extends SfpmPackageIdentity {
    isOrgDependent: boolean;
    packageVersionId?: string;
    packageId?: string;
    packageType: PackageType.Unlocked;
}

export interface SfpmPackageSource {
    repositoryUrl?: string;
    branch?: string;
    commitSHA?: string;
    tag?: string;
}

/**
 * A container for metadata that includes a mandatory baseline of all components
 * and optional specialized categorizations found by analyzers.
 */
export interface CategorizedMetadata {
    all: string[]; // The physical truth from ComponentSet
    [category: string]: string[] | undefined;
}

export interface SfpmPackageContent {
    metadataCount: number;
    payload?: PackageManifestObject;
    apex?: CategorizedMetadata & {
        classes?: string[];
        tests?: string[];
    };
    triggers?: string[];
    testSuites?: string[];
    fields?: CategorizedMetadata & {
        fht?: string[];
        ft?: string[];
        picklists?: string[];
    };
    profiles?: string[];
    permissionSetGroups?: string[];
    permissionSets?: string[];
    standardValueSets?: string[];
    flows?: string[];
    [key: string]: any;
}

export interface SfpmPackageValidation {
    testCoverage?: number;
    isCoverageCheckPassed?: boolean;
    isTriggerAllTests?: boolean;
}

export interface SfpmPackageOrchestration {
    creationDetails?: { duration?: number; timestamp?: number };
    deployments?: {
        targetOrg: string;
        subDirectory?: string;
        installationTime?: number;
        timestamp?: number
    }[];
    deploymentOptions?: DeploymentOptions;
    buildOptions?: SfpmPackageBuildOptions;
}

export interface SfpmPackageBuildOptions {
    isCoverageEnabled?: boolean;
    waitTime?: number;
}

export interface SfpmUnlockedPackageBuildOptions extends SfpmPackageBuildOptions {
    installationkey?: string;
    installationkeybypass?: boolean;
    isSkipValidation?: boolean;
    isAsyncValidation?: boolean;
    postInstallScript?: string;
    configFilePath?: string;
}

export interface SfpmDataPackageMetadata {
    identity: SfpmPackageIdentity;
    source: SfpmPackageSource;
    [key: string]: any;
}

/**
 * The "Source of Truth" for the JSON Artifact.
 * This represents the metadata file stored in the artifact.
 */
export interface SfpmPackageMetadata {
    identity: SfpmPackageIdentity;
    source: SfpmPackageSource;
    content: SfpmPackageContent;
    validation: SfpmPackageValidation;
    orchestration: SfpmPackageOrchestration;
    [key: string]: any;
}

export interface SfpmUnlockedPackageMetadata extends SfpmPackageMetadata {
    identity: SfpmUnlockedPackageIdentity;
}

/**
 * Represents merged view of sfpm artifacts + subscriber packages
 */
export interface InstalledArtifact {
    name: string;
    version: string;
    tag?: string;
    commitId?: string;
    isInstalledBySfpm?: boolean;
    sourceVersion?: string;
    isOrgDependent?: boolean;
    subscriberVersionId?: string;
    type?: PackageType
}

/**
 * @deprecated
 */
export interface PackageInfo {
    id?: string;
    package_name: string;
    package_version_number?: string;
    package_version_id?: string;
    package_type?: string;
    test_coverage?: number;
    has_passed_coverage_check?: boolean;
    repository_url?: string;
    sourceVersion?: string;
    branch?: string;
    apextestsuite?: string;
    isApexFound?: boolean;
    assignPermSetsPreDeployment?: string[];
    assignPermSetsPostDeployment?: string[];
    apexTestClassses?: string[];
    isPickListsFound?: boolean;
    isTriggerAllTests?: boolean;
    isProfilesFound?: boolean;
    isPermissionSetGroupFound?: boolean;
    isPromoted?: boolean;
    tag?: string;
    isDependencyValidated?: boolean;
    destructiveChanges?: any;
    destructiveChangesPath?: string;
    payload?: any;
    metadataCount?: number;
    sourceDir?: string;
    dependencies?: any;
    reconcileProfiles?: boolean;
    isPayLoadContainTypesSupportedByProfiles?: boolean;
    creation_details?: { creation_time?: number; timestamp?: number };
    deployments?: { target_org: string; sub_directory?: string; installation_time?: number; timestamp?: number }[];
    apiVersion?: string;
    postDeploymentScript?: string;
    preDeploymentScript?: string;
    apexClassWithOutTestClasses?: ApexClasses;
    triggers?: ApexClasses;
    configFilePath?: string;
    packageDescriptor?: any;
    commitSHAFrom?: string;
    commitSHATo?: string;
    packageDirectory?: string;
    apexClassesSortedByTypes?: ApexSortedByType;
    projectConfig?: any;
    changelogFilePath?: string;
}

