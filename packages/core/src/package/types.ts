import { ApexClasses } from "../types/apex.js";

export interface DiffPackageMetadata {
    sourceVersionFrom?: string;
    sourceVersionTo?: string;
    isProfilesFound?: boolean;
    apexTestClassses?: string[];
    isApexFound?: boolean;
    isPicklistFound?: boolean;
    isPermissionSetGroupFound?: boolean;
    isPermissionSetFound?: boolean;
    payload?: any;
    metadataCount?: number;
    profilesToReconcile?: number;
    destructiveChanges?: any;
    sourceDir?: string;
    invalidatedTestClasses?: ApexClasses;
    isPayLoadContainTypesSupportedByProfiles?: boolean;
}

export interface SfpmPackageParams {
    overridePackageTypeWith?: string;
    branch?: string;
    packageVersionNumber?: string;
    repositoryUrl?: string;
    sourceVersion?: string;
    configFilePath?: string;
    pathToReplacementForceIgnore?: string;
    revisionFrom?: string;
    revisionTo?: string;
}

export interface PackageTypeInfo {
    Id: string;
    Name: string;
    Description: string;
    NamespacePrefix: string;
    ContainerOptions: string;
    IsOrgDependent: boolean | string;
}

export interface Package2Detail {
    name: string;
    package2Id?: string;
    namespacePrefix?: string;
    subscriberPackageVersionId?: string;
    versionNumber?: string;
    type?: string;
    isOrgDependent?: boolean;
    key?: string;
}

export interface InstalledArtifact {
    name: string;
    version: string;
    commitId: string;
    isInstalledBysfp?: boolean;
    subscriberVersion?: string;
    type?: string;
}