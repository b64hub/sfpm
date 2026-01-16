import { ApexClasses } from "../types/apex.js";
import { PackageType } from "../types/package.js";

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

/**
 * Represents Package2 metadata from DevHub
 */
export interface Package2 {
    Id: string;
    Name: string;
    Description: string;
    NamespacePrefix: string;
    ContainerOptions: string;
    IsOrgDependent: boolean | string;
}

/**
 * Represents installed subscriber package data from InstalledSubscriberPackage
 */
export interface SubscriberPackage {
    name: string;
    package2Id?: string;
    namespacePrefix?: string;
    subscriberPackageVersionId?: string;
    versionNumber?: string;
    type?: Extract<PackageType, 'Unlocked' | 'Managed'>;
    isOrgDependent?: boolean;
    key?: string;
}

/**
 * Represents merged view of sfpm artifacts + subscriber packages
 */
export interface InstalledArtifact {
    name: string;
    version: string;
    commitId: string;
    isInstalledBySfpm?: boolean;
    subscriberVersion?: string;
    type?: PackageType
}