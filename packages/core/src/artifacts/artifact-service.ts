import { Org, Connection } from "@salesforce/core";
import path from "path";
import fs from "fs-extra";
import SfpmPackage from "../package/sfpm-package.js";
import { Logger } from "../types/logger.js";
import { InstalledArtifact, PackageType, SfpmPackageMetadata } from "../types/package.js";
import { ArtifactManifest } from "../types/artifact.js";

export interface SfpmArtifact__c {
    Id?: string;
    Name: string;
    Tag__c: string;
    Version__c: string;
    CommitId__c: string;
}

export class ArtifactService {
    private org?: Org;
    private logger?: Logger;

    constructor(logger?: Logger, org?: Org) {
        this.logger = logger;
        this.org = org;
    }

    public async getInstalledPackages(orderBy: string = 'Name'): Promise<InstalledArtifact[]> {
        if (!this.org) {
            throw new Error('Org connection required for getInstalledPackages');
        }

        try {
            const records = await this.query<SfpmArtifact__c>(
                `SELECT Id, Name, CommitId__c, Version__c, Tag__c FROM SfpmArtifact__c ORDER BY ${orderBy} ASC`,
                this.org.getConnection(),
                false
            );

            // Map SfpmArtifact__c records to SfpmPackage instances
            return records.map(record => {
                return {
                    name: record.Name,
                    version: record.Version__c,
                    tag: record.Tag__c,
                    commitId: record.CommitId__c,
                    type: undefined,
                }
            });
        } catch (error) {
            this.logger?.warn(
                'Unable to fetch any sfp artifacts in the org\n' +
                '1. sfpowerscripts artifact package is not installed in the org\n' +
                '2. The required prerequisite object is not deployed to this org\n'
            );
            return [];
        }
    }

    /**
     * Check whether an artifact is installed in the org
     * @param packageName - Name of the package to check
     * @param version - Optional version to check for exact match
     * @returns Object with isInstalled flag and versionNumber if found
     */
    public async isArtifactInstalled(
        packageName: string,
        version?: string
    ): Promise<{ isInstalled: boolean; versionNumber?: string }> {
        if (!this.org) {
            throw new Error('Org connection required for isArtifactInstalled');
        }

        let result: { isInstalled: boolean; versionNumber?: string } = {
            isInstalled: false,
        };

        try {
            this.logger?.debug(`Querying for version of ${packageName} in the Org.`);

            const installedArtifacts = await this.query<SfpmArtifact__c>(
                `SELECT Id, Name, Version__c FROM SfpmArtifact__c WHERE Name = '${packageName}'`,
                this.org!.getConnection(),
                false
            );

            if (installedArtifacts.length > 0) {
                const artifact = installedArtifacts[0];
                result.versionNumber = artifact.Version__c;

                if (version) {
                    result.isInstalled = artifact.Version__c === version;
                } else {
                    result.isInstalled = true;
                }
            }
        } catch (error) {
            this.logger?.warn(
                'Unable to fetch sfp artifacts in the org\n' +
                '1. sfp package is not installed in the org\n' +
                '2. The required prerequisite object is not deployed to this org\n'
            );
        }

        return result;
    }

    /**
     * Create or update an artifact record in the org
     * @param sfpmPackage - Package to create/update artifact for
     * @returns Artifact record ID
     */
    public async upsertArtifact(sfpmPackage: SfpmPackage): Promise<string | undefined> {
        if (!this.org) {
            throw new Error('Org connection required for upsertArtifact');
        }

        try {
            const artifactId = await this.getArtifactRecordId(sfpmPackage.name);

            this.logger?.info(
                `Existing artifact record id for ${sfpmPackage.name} in Org for ${sfpmPackage.version}: ${artifactId || 'N/A'}`
            );

            const artifactData = {
                Name: sfpmPackage.name,
                Tag__c: sfpmPackage.tag,
                Version__c: sfpmPackage.version,
                CommitId__c: sfpmPackage.commitId || '',
            };

            let resultId: string;

            if (!artifactId) {
                // Create new record
                const result = await this.org.getConnection().sobject('SfpmArtifact__c').create(artifactData);
                if (Array.isArray(result)) {
                    resultId = result[0].id!;
                } else {
                    resultId = result.id!;
                }
                this.logger?.info(`Created new artifact record: ${resultId}`);
            } else {
                // Update existing record
                const result = await this.org.getConnection().sobject('SfpmArtifact__c').update({
                    Id: artifactId,
                    ...artifactData
                });
                if (Array.isArray(result)) {
                    resultId = result[0].id!;
                } else {
                    resultId = result.id!;
                }
                this.logger?.info(`Updated artifact record: ${resultId}`);
            }

            this.logger?.info(
                `Updated Org with Artifact ${sfpmPackage.name} ${sfpmPackage.apiVersion} ${sfpmPackage.version} ${resultId}`
            );

            return resultId;
        } catch (error) {
            this.logger?.warn(
                'Unable to update sfp artifacts in the org, skipping updates\n' +
                '1. sfp artifact package is not installed in the org\n' +
                '2. The required prerequisite object is not deployed to this org'
            );
            return undefined;
        }
    }

    /**
     * Get the Salesforce record ID for an artifact by package name
     * @param packageName - Name of the package
     * @returns Record ID or undefined if not found
     */
    private async getArtifactRecordId(packageName: string): Promise<string | undefined> {
        try {
            const artifacts = await this.query<SfpmArtifact__c>(
                `SELECT Id FROM SfpmArtifact__c WHERE Name = '${packageName}' LIMIT 1`,
                this.org!.getConnection(),
                false
            );

            return artifacts.length > 0 ? artifacts[0].Id : undefined;
        } catch (error) {
            return undefined;
        }
    }

    /**
     * Private query helper method - JSforce v3+ handles network retries automatically
     */
    private async query<T>(query: string, conn: Connection, isTooling: boolean): Promise<T[]> {
        let records;
        if (isTooling) {
            records = (await conn.tooling.query(query)).records;
        } else {
            records = (await conn.query(query)).records;
        }
        return records as T[];
    }

    // ========================================================================
    // Local Artifact Management
    // ========================================================================

    /**
     * Get the path to the local artifacts directory for a package
     * @param projectDirectory - Root project directory
     * @param packageName - Name of the package
     * @returns Path to the package's artifact directory
     */
    public getLocalArtifactPath(projectDirectory: string, packageName: string): string {
        return path.join(projectDirectory, 'artifacts', packageName);
    }

    /**
     * Check if local artifacts exist for a package
     * @param projectDirectory - Root project directory
     * @param packageName - Name of the package
     * @returns True if artifacts exist
     */
    public hasLocalArtifacts(projectDirectory: string, packageName: string): boolean {
        const artifactPath = this.getLocalArtifactPath(projectDirectory, packageName);
        const manifestPath = path.join(artifactPath, 'manifest.json');
        return fs.existsSync(manifestPath);
    }

    /**
     * Read the manifest for a local artifact
     * @param projectDirectory - Root project directory
     * @param packageName - Name of the package
     * @returns Artifact manifest or undefined if not found
     */
    public getLocalArtifactManifest(projectDirectory: string, packageName: string): ArtifactManifest | undefined {
        try {
            const artifactPath = this.getLocalArtifactPath(projectDirectory, packageName);
            const manifestPath = path.join(artifactPath, 'manifest.json');

            if (!fs.existsSync(manifestPath)) {
                this.logger?.debug(`No manifest found at ${manifestPath}`);
                return undefined;
            }

            return fs.readJsonSync(manifestPath);
        } catch (error) {
            this.logger?.warn(`Failed to read artifact manifest: ${error instanceof Error ? error.message : String(error)}`);
            return undefined;
        }
    }

    /**
     * Get the latest version from a local artifact
     * @param projectDirectory - Root project directory
     * @param packageName - Name of the package
     * @returns Latest version or undefined if not found
     */
    public getLocalArtifactLatestVersion(projectDirectory: string, packageName: string): string | undefined {
        const manifest = this.getLocalArtifactManifest(projectDirectory, packageName);
        return manifest?.latest;
    }

    /**
     * Read artifact metadata for a specific version
     * @param projectDirectory - Root project directory
     * @param packageName - Name of the package
     * @param version - Version to read (defaults to latest)
     * @returns Package metadata or undefined if not found
     */
    public getLocalArtifactMetadata(
        projectDirectory: string,
        packageName: string,
        version?: string
    ): SfpmPackageMetadata | undefined {
        try {
            const manifest = this.getLocalArtifactManifest(projectDirectory, packageName);
            if (!manifest) {
                return undefined;
            }

            const targetVersion = version || manifest.latest;
            if (!targetVersion) {
                this.logger?.warn(`No version specified and no latest version in manifest for ${packageName}`);
                return undefined;
            }

            // Check if version exists in manifest
            if (!manifest.versions[targetVersion]) {
                this.logger?.warn(`Version ${targetVersion} not found in manifest for ${packageName}`);
                return undefined;
            }

            // Try to read metadata file
            const artifactPath = this.getLocalArtifactPath(projectDirectory, packageName);
            const metadataPath = path.join(artifactPath, targetVersion, 'artifact_metadata.json');

            if (!fs.existsSync(metadataPath)) {
                this.logger?.debug(`No artifact_metadata.json found at ${metadataPath}`);
                return undefined;
            }

            return fs.readJsonSync(metadataPath);
        } catch (error) {
            this.logger?.warn(`Failed to read artifact metadata: ${error instanceof Error ? error.message : String(error)}`);
            return undefined;
        }
    }

    /**
     * Get local artifact information including version and metadata
     * @param projectDirectory - Root project directory
     * @param packageName - Name of the package
     * @param version - Optional specific version (defaults to latest)
     * @returns Object with version, manifest, and metadata
     */
    public getLocalArtifactInfo(
        projectDirectory: string,
        packageName: string,
        version?: string
    ): {
        version?: string;
        manifest?: ArtifactManifest;
        metadata?: SfpmPackageMetadata;
        versionInfo?: ArtifactManifest['versions'][string];
    } {
        const manifest = this.getLocalArtifactManifest(projectDirectory, packageName);
        
        if (!manifest) {
            return {};
        }

        const targetVersion = version || manifest.latest;
        const versionInfo = targetVersion ? manifest.versions[targetVersion] : undefined;
        const metadata = this.getLocalArtifactMetadata(projectDirectory, packageName, targetVersion);

        return {
            version: targetVersion,
            manifest,
            metadata,
            versionInfo,
        };
    }

    // ========================================================================
    // Future: Remote Artifact Management
    // ========================================================================
    // Methods for retrieving artifacts from remote repositories (npm, etc.)
    // can be added here in the future
}