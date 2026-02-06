import { Org, Connection } from '@salesforce/core';
import SfpmPackage from '../package/sfpm-package.js';
import { Logger } from '../types/logger.js';
import { InstalledArtifact, SfpmPackageMetadata } from '../types/package.js';
import { ArtifactManifest, ArtifactVersionEntry, ResolvedArtifact, ArtifactResolveOptions } from '../types/artifact.js';
import { ArtifactRepository } from './artifact-repository.js';
import { ArtifactResolver } from './artifact-resolver.js';
import { soql } from '../utils/soql.js';

export interface SfpmArtifact__c {
    Id?: string;
    Name: string;
    Tag__c: string;
    Version__c: string;
    Commit_Id__c: string;
    Checksum__c: string;
}

/**
 * Result of install target resolution.
 * Combines artifact resolution with org installation status.
 */
export interface InstallTarget {
    /** The package name */
    packageName: string;
    /** The resolved artifact to install */
    resolved: ResolvedArtifact;
    /** Current installation status in the org */
    orgStatus: {
        /** Whether the package is currently installed */
        isInstalled: boolean;
        /** The currently installed version (if any) */
        installedVersion?: string;
        /** The currently installed sourceHash (if any) */
        installedSourceHash?: string;
    };
    /** Whether installation is needed */
    needsInstall: boolean;
    /** Reason for the install decision */
    installReason: 'not-installed' | 'version-upgrade' | 'version-downgrade' | 'hash-mismatch' | 'already-installed';
}

const ARTIFACT_FIELDS = ['Id', 'Name', 'Tag__c', 'Version__c', 'Commit_Id__c', 'Checksum__c'];

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
                soql`SELECT ${ARTIFACT_FIELDS.join(', ')} FROM SfpmArtifact__c ORDER BY ${orderBy} ASC`,
                this.org.getConnection(),
                false,
            );

            // Map SfpmArtifact__c records to InstalledArtifact instances
            return records.map((record) => {
                return {
                    name: record.Name,
                    version: record.Version__c,
                    tag: record.Tag__c,
                    commitId: record.Commit_Id__c,
                    checksum: record.Checksum__c,
                    type: undefined,
                };
            });
        } catch (error) {
            this.logger?.warn(
                'Unable to fetch any sfpm artifacts in the org\n' +
                    '1. sfpm artifact package is not installed in the org\n' +
                    '2. The required prerequisite object is not deployed to this org\n',
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
        version?: string,
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
                soql`SELECT ${ARTIFACT_FIELDS.join(', ')} FROM SfpmArtifact__c WHERE Name = '${packageName}'`,
                this.org!.getConnection(),
                false,
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
                'Unable to fetch sfpm artifacts in the org\n' +
                    '1. sfpm package is not installed in the org\n' +
                    '2. The required prerequisite object is not deployed to this org\n',
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
                `Existing artifact record id for ${sfpmPackage.name} in Org for ${sfpmPackage.version}: ${artifactId || 'N/A'}`,
            );

            const artifactData = {
                Name: sfpmPackage.name,
                Tag__c: sfpmPackage.tag,
                Version__c: sfpmPackage.version,
                Commit_Id__c: sfpmPackage.commitId || '',
                Checksum__c: sfpmPackage.sourceHash,
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
                const result = await this.org
                    .getConnection()
                    .sobject('SfpmArtifact__c')
                    .update({
                        Id: artifactId,
                        ...artifactData,
                    });
                if (Array.isArray(result)) {
                    resultId = result[0].id!;
                } else {
                    resultId = result.id!;
                }
                this.logger?.info(`Updated artifact record: ${resultId}`);
            }

            this.logger?.info(
                `Updated Org with Artifact ${sfpmPackage.name} ${sfpmPackage.apiVersion} ${sfpmPackage.version} ${resultId}`,
            );

            return resultId;
        } catch (error) {
            this.logger?.warn(
                'Unable to update sfpm artifacts in the org, skipping updates\n' +
                    '1. sfpm artifact package is not installed in the org\n' +
                    '2. The required prerequisite object is not deployed to this org',
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
                soql`SELECT ${ARTIFACT_FIELDS.join(', ')} FROM SfpmArtifact__c WHERE Name = '${packageName}' LIMIT 1`,
                this.org!.getConnection(),
                false,
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

    /**
     * Resolve the install target for a package.
     * 
     * This is the main orchestration method that:
     * 1. Resolves the best available artifact (local or from npm registry)
     * 2. Checks what's currently installed in the target org
     * 3. Determines if installation is needed and why
     * 
     * Uses npm config (.npmrc) for registry and auth token resolution,
     * including support for scoped registries (e.g., @myorg packages).
     * 
     * @param projectDirectory - Root project directory for artifact storage
     * @param packageName - Name of the package to resolve (SFPM package name, not npm name)
     * @param options - Resolution options (version, forceRefresh, npmScope, etc.)
     * @returns InstallTarget with resolved artifact and install decision
     */
    public async resolveInstallTarget(
        projectDirectory: string,
        packageName: string,
        options?: ArtifactResolveOptions & { 
            localOnly?: boolean;
            /** npm scope for scoped registry lookup (e.g., "@myorg") */
            npmScope?: string;
        }
    ): Promise<InstallTarget> {
        // Construct the npm package name (with scope if provided)
        const npmPackageName = options?.npmScope 
            ? `${options.npmScope}/${packageName}` 
            : packageName;
        
        // 1. Create resolver for this specific package (handles scoped registries)
        const resolver = await ArtifactResolver.createForPackage(
            projectDirectory, 
            npmPackageName, 
            this.logger, 
            {
                localOnly: options?.localOnly,
            }
        );
        
        // Note: We still use the SFPM package name for local artifact resolution
        // since that's how artifacts are stored locally
        const resolved = await resolver.resolve(packageName, options);
        this.logger?.debug(`Resolved ${packageName} to version ${resolved.version} from ${resolved.source}`);

        // 2. Check org installation status (if org is available)
        let orgStatus: InstallTarget['orgStatus'] = {
            isInstalled: false,
        };

        if (this.org) {
            const installed = await this.isArtifactInstalled(packageName);
            if (installed.isInstalled) {
                // Get more details about the installed version
                const installedPackages = await this.getInstalledPackages();
                const installedPkg = installedPackages.find(p => p.name === packageName);
                
                orgStatus = {
                    isInstalled: true,
                    installedVersion: installed.versionNumber,
                    installedSourceHash: installedPkg?.checksum, // Checksum__c stores sourceHash
                };
            }
        }

        // 3. Determine if installation is needed
        const { needsInstall, installReason } = this.determineInstallNeed(
            resolved,
            orgStatus,
        );

        return {
            packageName,
            resolved,
            orgStatus,
            needsInstall,
            installReason,
        };
    }

    /**
     * Determine if installation is needed based on resolved artifact and org status.
     */
    private determineInstallNeed(
        resolved: ResolvedArtifact,
        orgStatus: InstallTarget['orgStatus']
    ): { needsInstall: boolean; installReason: InstallTarget['installReason'] } {
        // Not installed - definitely needs install
        if (!orgStatus.isInstalled) {
            return { needsInstall: true, installReason: 'not-installed' };
        }

        // Compare versions
        if (orgStatus.installedVersion !== resolved.version) {
            // Version mismatch - check if upgrade or downgrade
            // For simplicity, we'll just say it needs install if versions differ
            // A more sophisticated approach could use semver comparison
            return { needsInstall: true, installReason: 'version-upgrade' };
        }

        // Same version - check source hash if available
        if (resolved.versionEntry.sourceHash && orgStatus.installedSourceHash) {
            if (resolved.versionEntry.sourceHash !== orgStatus.installedSourceHash) {
                return { needsInstall: true, installReason: 'hash-mismatch' };
            }
        }

        // Everything matches
        return { needsInstall: false, installReason: 'already-installed' };
    }

    /**
     * Get an ArtifactRepository for the given project directory.
     * Use this for lower-level artifact operations like reading manifests,
     * checking if artifacts exist, getting metadata, etc.
     */
    public getRepository(projectDirectory: string): ArtifactRepository {
        return new ArtifactRepository(projectDirectory, this.logger);
    }
}
