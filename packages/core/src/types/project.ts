import type { PackageType } from "./package.js";
import { ProjectJsonSchema, ProjectJson } from '@salesforce/core';
import { z } from 'zod';

/**
 * Extension of the standard Salesforce Package Directory (packageDirectories entry).
 */
export type PackageDir = ProjectJson['packageDirectories'][number];

export interface DeploymentOptions {
    optimize?: boolean;
    pre: {
        reconcileProfiles?: boolean;
        script?: string;
        assignPermSets?: string[];
        destructiveChanges?: string;
        unpackagedMetadata?: { path: string };
    },
    post: {
        settings?: {
            FHT?: boolean;
            FT?: boolean;
        };
        script?: string;
        assignPermSets?: string[];
        destructiveChanges?: string;
        unpackagedMetadata?: { path: string };
    }
}

// Our Orchestration tool expects packages to have a name (package) and we add custom metadata.
// We explicitly include 'package', 'versionNumber', 'path' and 'dependencies' here because 
// PackageDir is a union in @salesforce/core, and not all members of that union have these properties.
export type PackageDefinition = PackageDir & {
    package: string;
    versionNumber: string;
    path: string;
    dependencies?: { package: string; versionNumber: string }[];
    type?: PackageType;
    envAliased?: string;
    skip?: string[];
    deploymentOptions?: DeploymentOptions,
    buildOptions?: {
    },
    preDeploymentScript?: string;
    postDeploymentScript?: string;
    unpackagedMetadata?: { path: string };
    enableFHT?: boolean;
    assignPermSetsPreDeployment?: string[];
    assignPermSetsPostDeployment?: string[];
    destructiveChangesPath?: string;
    reconcileProfiles?: boolean;
    ignore?: string[];
};

/**
 * Extension of the standard sfdx-project.json structure.
 */
export interface ProjectDefinition extends ProjectJson {
    // Override standard array to use our PackageDefinition
    packageDirectories: PackageDefinition[];
    plugins?: {
        sfpm?: {
            ignoreFiles?: {
                prepare?: string;
                validate?: string;
                quickbuild?: string;
                build?: string;
            };
        };
    };
}

// Extend the core PackageDir schema with our custom fields
export const PackageDefinitionSchema = z.intersection(
    ProjectJsonSchema.shape.packageDirectories.element,
    z.object({
        type: z.string().optional(),
        envAliased: z.string().optional(),
        dependencies: z.array(z.object({ package: z.string(), versionNumber: z.string() })).optional(),
        skip: z.array(z.string()).optional(),
        deploymentOptions: z.object({
            optimize: z.boolean().optional(),
            pre: z.object({
                settings: z.object({
                    FHT: z.boolean().optional(),
                }).optional(),
                reconcileProfiles: z.boolean().optional(),
                script: z.string().optional(),
                assignPermSets: z.array(z.string()).optional(),
                destructiveChanges: z.string().optional(),
                unpackagedMetadata: z.object({ path: z.string() }).optional(),
            }).optional(),
            post: z.object({
                script: z.string().optional(),
                assignPermSets: z.array(z.string()).optional(),
                destructiveChanges: z.string().optional(),
                unpackagedMetadata: z.object({ path: z.string() }).optional(),
            }).optional(),
        }).optional(),
        buildOptions: z.object({}).optional(),
    })
);

// Extend the core ProjectJson schema
export const ProjectDefinitionSchema = ProjectJsonSchema.extend({
    packageDirectories: z.array(PackageDefinitionSchema),
    plugins: z.object({
        sfpm: z.object({
            ignoreFiles: z.object({
                prepare: z.string().optional(),
                validate: z.string().optional(),
                quickbuild: z.string().optional(),
                build: z.string().optional(),
            }).optional(),
        }).optional(),
    }).optional(),
});