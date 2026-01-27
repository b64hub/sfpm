import type { PackageType } from "./package.js";
import { ProjectJsonSchema, ProjectJson } from '@salesforce/core';
import { z } from 'zod';

/**
 * Extension of the standard Salesforce Package Directory (packageDirectories entry).
 */
export type PackageDir = ProjectJson['packageDirectories'][number];

export interface PackageOptions {
    envAliased?: boolean;
    skip?: string[];
    ignore?: string[];
    deploy?: DeploymentOptions;
    build?: BuildOptions;
    validate?: any;
    [key: string]: any;
}

export interface BuildOptions {
    skipValidation?: boolean;
}

export interface DeploymentOptions {
    optimize?: boolean;
    pre?: {
        reconcileProfiles?: boolean;
        script?: string;
        assignPermSets?: string[];
        destructiveChanges?: string;
        // unpackagedMetadata?: { path: string };
    },
    post?: {
        settings?: {
            FHT?: boolean;
            FT?: boolean;
        };
        script?: string;
        assignPermSets?: string[];
        destructiveChanges?: string;
        // unpackagedMetadata?: { path: string };
    }
}

// Our Orchestration tool expects packages to have a name (package) and we add custom metadata.
// We explicitly include 'package', 'versionNumber', 'path' and 'dependencies' here because 
// PackageDir is a union in @salesforce/core, and not all members of that union have these properties.
// We define this as an interface that structurally matches the versioned package variant of PackageDir
// plus our custom extensions, avoiding union distribution issues while maintaining compatibility.
export interface PackageDefinition extends Extract<PackageDir, { package: string, versionNumber: string, path: string }> {
    type?: PackageType;
    packageOptions?: PackageOptions;
}

/**
 * Extension of the standard sfdx-project.json structure.
 */
export interface ProjectDefinition extends ProjectJson {
    // Override standard array to use our PackageDefinition, while also allowing the base PackageDir type
    packageDirectories: (PackageDefinition | PackageDir)[];
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
        packageOptions: z.object({
            envAliased: z.string().optional(),
            skip: z.array(z.string()).optional(),
            ignore: z.array(z.string()).optional(),
            deploy: z.object({
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
            build: z.object({}).optional(),
        }).optional(),
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