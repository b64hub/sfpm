
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
    isPayLoadContainTypesSupportedByProfiles?:boolean;
}

export interface SfpPackageParams {
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