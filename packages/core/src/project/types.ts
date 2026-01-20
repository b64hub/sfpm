import type { PackageType } from "../types/package.js";
import { ProjectJsonSchema, ProjectJson } from '@salesforce/core';
import { z } from 'zod';

/**
 * Extension of the standard Salesforce Package Directory (packageDirectories entry).
 */
export type PackageDir = ProjectJson['packageDirectories'][number];

// Our Orchestration tool expects packages to have a name (package) and we add custom metadata.
// We explicitly include 'package', 'versionNumber', 'path' and 'dependencies' here because 
// PackageDir is a union in @salesforce/core, and not all members of that union have these properties.
export type PackageDefinition = PackageDir & {
    package: string;
    versionNumber: string;
    path: string;
    dependencies?: { package: string; versionNumber: string }[];
    type?: PackageType;
    envAlias?: string;
    ignoreOnStage?: string[];
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
        envAlias: z.string().optional(),
        ignoreOnStage: z.array(z.string()).optional(),
        preDeploymentScript: z.string().optional(),
        postDeploymentScript: z.string().optional(),
        dependencies: z.array(z.object({ package: z.string(), versionNumber: z.string() })).optional(),
        unpackagedMetadata: z.object({ path: z.string() }).optional(),
        assignPermSetsPreDeployment: z.array(z.string()).optional(),
        assignPermSetsPostDeployment: z.array(z.string()).optional(),
        destructiveChangesPath: z.string().optional(),
        reconcileProfiles: z.boolean().optional(),
        ignore: z.array(z.string()).optional(),
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