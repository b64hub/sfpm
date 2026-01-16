import type { PackageType } from "../types/package.js";

export interface ProjectDefinition {
    packageDirectories: PackageDefinition[];
    packageAliases?: { [key: string]: string };     
    namespace?: string;
    sfdcLoginUrl?: string;
    sourceApiVersion?: string;
}

export interface PackageDefinition {
    package: string;
    path: string;
    default: boolean;
    versionNumber?: string;
    type?: PackageType;
    versionDescription?: string;
    dependencies?: { package: string; versionNumber: string }[];
    ignoreOnStages?: string[];
}
