import { ApexClasses, ApexSortedByType } from "./apex.js";

export enum PackageType { Unlocked = 'unlocked', Source = 'source', Data = 'data', Diff = 'diff', Managed = 'managed' }


export interface PackageIdentity {
    id?: string;
    packageName: string;
    packageVersionNumber?: string;
    packageVersionId?: string;
    packageType: PackageType;
    apiVersion?: string;
}

export interface SourceContext {
    repositoryUrl?: string;
    branch?: string;
    sourceVersion?: string;
    commitSHAFrom?: string;
    commitSHATo?: string;
    tag?: string;
}

export interface ApexInfo {
    isApexFound?: boolean;
    apexTestClasses?: string[];
    apexClassWithOutTestClasses?: ApexClasses;
    triggers?: ApexClasses;
    apexClassesSortedByTypes?: ApexSortedByType;
    testCoverage?: number;
    hasPassedCoverageCheck?: boolean;
    isTriggerAllTests?: boolean;
    apextestsuite?: string;
}

export interface ManifestInfo {
    payload?: any;
    metadataCount?: number;
    isPickListsFound?: boolean;
    isProfilesFound?: boolean;
    isPermissionSetGroupFound?: boolean;
    isPayLoadContainTypesSupportedByProfiles?: boolean;
    reconcileProfiles?: boolean;
    destructiveChanges?: any;
}

export interface DeploymentSteps {
    preDeploymentScript?: string;
    postDeploymentScript?: string;
    assignPermSetsPreDeployment?: string[];
    assignPermSetsPostDeployment?: string[];
}

/**
 * The "Source of Truth" for the JSON Artifact.
 * This represents the metadata file stored in the artifact.
 */
export interface SfpmPackageMetadata extends 
    PackageIdentity, 
    SourceContext, 
    ApexInfo, 
    ManifestInfo, 
    DeploymentSteps 
{
    creationDetails?: { creationTime?: number; timestamp?: number };
    deployments?: { 
        targetOrg: string; 
        subDirectory?: string; 
        installationTime?: number; 
        timestamp?: number 
    }[];
    [key: string]: any; 
}

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