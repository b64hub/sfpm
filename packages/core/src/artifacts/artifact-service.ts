import { Org, Connection } from "@salesforce/core";
import SfpmPackage from "../package/sfpm-package.js";
import { Logger } from "../types/logger.js";
import { InstalledArtifact, PackageType } from "../types/package.js";

export interface SfpmArtifact__c {
    Id?: string;
    Name: string;
    Tag__c: string;
    Version__c: string;
    CommitId__c: string;
}

export class ArtifactService {
    private org: Org;
    private logger: Logger;

    constructor(org: Org, logger: Logger) {
        this.org = org;
        this.logger = logger;
    }

    public async getInstalledPackages(orderBy: string = 'Name'): Promise<InstalledArtifact[]> {
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
            this.logger.warn(
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
        let result: { isInstalled: boolean; versionNumber?: string } = {
            isInstalled: false,
        };

        try {
            this.logger.debug(`Querying for version of ${packageName} in the Org.`);

            const installedArtifacts = await this.query<SfpmArtifact__c>(
                `SELECT Id, Name, Version__c FROM SfpmArtifact__c WHERE Name = '${packageName}'`,
                this.org.getConnection(),
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
            this.logger.warn(
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
        try {
            const artifactId = await this.getArtifactRecordId(sfpmPackage.name);

            this.logger.info(
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
                this.logger.info(`Created new artifact record: ${resultId}`);
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
                this.logger.info(`Updated artifact record: ${resultId}`);
            }

            this.logger.info(
                `Updated Org with Artifact ${sfpmPackage.name} ${sfpmPackage.apiVersion} ${sfpmPackage.version} ${resultId}`
            );

            return resultId;
        } catch (error) {
            this.logger.warn(
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
                this.org.getConnection(),
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
}