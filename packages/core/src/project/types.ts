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
    type?: Omit<PackageType, 'Managed'>;
    versionDescription?: string;
    dependencies?: PackageDependency[];
    ignoreOnStages?: string[];
}

export interface PackageDependency {
    package: string;
    versionNumber: string;
}

export interface ProjectFileReader {
    read(): Promise<ProjectDefinition>;
    write(project: ProjectDefinition): Promise<void>;
}