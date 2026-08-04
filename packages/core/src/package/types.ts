import {ApexClasses} from '../types/apex.js';

export interface DiffPackageMetadata {
  apexTestClassses?: string[];
  destructiveChanges?: any;
  invalidatedTestClasses?: ApexClasses;
  isApexFound?: boolean;
  isPayLoadContainTypesSupportedByProfiles?: boolean;
  isPermissionSetFound?: boolean;
  isPermissionSetGroupFound?: boolean;
  isPicklistFound?: boolean;
  isProfilesFound?: boolean;
  metadataCount?: number;
  payload?: any;
  profilesToReconcile?: number;
  sourceDir?: string;
  sourceVersionFrom?: string;
  sourceVersionTo?: string;
}

export interface SfpmPackageParams {
  branch?: string;
  configFilePath?: string;
  overridePackageTypeWith?: string;
  packageVersionNumber?: string;
  pathToReplacementForceIgnore?: string;
  repositoryUrl?: string;
  revisionFrom?: string;
  revisionTo?: string;
  sourceVersion?: string;
}

