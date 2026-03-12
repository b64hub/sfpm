import {ProjectJson, ProjectJsonSchema} from '@salesforce/core';
import {z} from 'zod';

import type {PackageType} from './package.js';

/** Salesforce key prefix for subscriber package version IDs */
export const SUBSCRIBER_PKG_VERSION_ID_PREFIX = '04t';

/**
 * Extension of the standard Salesforce Package Directory (packageDirectories entry).
 */
export type PackageDir = ProjectJson['packageDirectories'][number];

export interface PackageOptions {
  [key: string]: any;
  build?: BuildOptions;
  deploy?: DeploymentOptions;
  envAliased?: boolean;
  ignore?: string[];
  skip?: string[];
  validate?: any;
}

export interface BuildOptions {
  skipValidation?: boolean;
}

export interface DeploymentOptions {
  optimize?: boolean;
  post?: {
    assignPermSets?: string[];
    destructiveChanges?: string;
    script?: string;
    settings?: {
      FHT?: boolean;
      FT?: boolean;
    };
    // unpackagedMetadata?: { path: string };
  }
  pre?: {
    assignPermSets?: string[];
    destructiveChanges?: string;
    reconcileProfiles?: boolean;
    script?: string;
    // unpackagedMetadata?: { path: string };
  },
}

/**
 * Versioned package directory entry with SFPM extensions.
 * Extracts the named+versioned variant of PackageDir to avoid union distribution issues.
 */
export interface PackageDefinition extends Extract<PackageDir, {package: string, path: string; versionNumber: string,}> {
  packageOptions?: PackageOptions;
  type?: PackageType;
}

/**
 * Represents an external/managed package dependency that is not part of the
 * project's packageDirectories. These are packages (e.g. Nebula Logger) that
 * are referenced as dependencies but whose source is not in the project.
 *
 * Managed dependencies are identified by:
 * - Being listed in a package's `dependencies` array without a `versionNumber`
 * - Having a corresponding `packageAliases` entry that resolves to a
 *   subscriber package version ID (04t prefix)
 * - Having NO entry in `packageDirectories` (no local path)
 */
export interface ManagedPackageDefinition {
  /** The full package reference as it appears in dependencies and aliases (e.g. "Nebula Logger@4.16.0") */
  package: string;
  /** The subscriber package version ID (starts with 04t) resolved from packageAliases */
  packageVersionId: string;
}

/**
 * Extension of the standard sfdx-project.json structure.
 */
export interface ProjectDefinition extends ProjectJson {
  // Override standard array to use our PackageDefinition, while also allowing the base PackageDir type
  packageDirectories: (PackageDefinition | PackageDir)[];
}

// Extend the core PackageDir schema with our custom fields
export const PackageDefinitionSchema = z.intersection(
  ProjectJsonSchema.shape.packageDirectories.element,
  z.object({
    packageOptions: z.object({
      build: z.object({}).optional(),
      deploy: z.object({
        optimize: z.boolean().optional(),
        post: z.object({
          assignPermSets: z.array(z.string()).optional(),
          destructiveChanges: z.string().optional(),
          script: z.string().optional(),
          unpackagedMetadata: z.object({path: z.string()}).optional(),
        }).optional(),
        pre: z.object({
          assignPermSets: z.array(z.string()).optional(),
          destructiveChanges: z.string().optional(),
          reconcileProfiles: z.boolean().optional(),
          script: z.string().optional(),
          settings: z.object({
            FHT: z.boolean().optional(),
          }).optional(),
          unpackagedMetadata: z.object({path: z.string()}).optional(),
        }).optional(),
      }).optional(),
      envAliased: z.string().optional(),
      ignore: z.array(z.string()).optional(),
      skip: z.array(z.string()).optional(),
    }).optional(),
    type: z.string().optional(),
  }),
);

// Extend the core ProjectJson schema
export const ProjectDefinitionSchema = ProjectJsonSchema.extend({
  packageDirectories: z.array(PackageDefinitionSchema),
});
