import { PackageManifestObject } from "@salesforce/source-deploy-retrieve";
import { ApexClasses } from "./apex.js";

export enum PackageType { Unlocked = 'unlocked', Source = 'source', Data = 'data', Diff = 'diff', Managed = 'managed' }

export type MetadataFile = string | {
    name: string;
    path?: string;
}

export interface SfpmPackageIdentity {
    id?: string;
    packageName: string;
    versionNumber?: string;
    packageVersionId?: string;
    packageType: Omit<PackageType, 'managed'>;
    apiVersion?: string;
}

export interface SfpmPackageSource {
    repositoryUrl?: string;
    branch?: string;
    sourceVersion?: string;
    commitSHAFrom?: string;
    commitSHATo?: string;
    tag?: string;
}

export interface SfpmPackageContent {
    metadataCount: number;
    payload?: PackageManifestObject;
    apex?: {
        classes?: string[];
        tests?: string[];
    };
    triggers?: string[];
    testSuites?: string[];
    standardValueSets?: string[];
    [key: string]: any;
}

export interface SfpmPackageValidation {
    testCoverage?: number;
    hasPassedCoverageCheck?: boolean;
    isTriggerAllTests?: boolean;
}

export interface SfpmPackageOrchestration {
    preDeploymentScript?: string;
    postDeploymentScript?: string;
    assignPermSetsPreDeployment?: string[];
    assignPermSetsPostDeployment?: string[];
    reconcileProfiles?: boolean;
    destructiveChangesPath?: string;
    creationDetails?: { duration?: number; timestamp?: number };
    deployments?: {
        targetOrg: string;
        subDirectory?: string;
        installationTime?: number;
        timestamp?: number
    }[];
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

