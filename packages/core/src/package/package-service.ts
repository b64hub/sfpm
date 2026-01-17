import { Org } from "@salesforce/core";
import { Logger } from "../types/logger.js";
import { PackageType } from "../types/package.js";

/**
 * Represents Package2 metadata from DevHub
 */
export interface Package2 {
    Id: string;
    Name: string;
    Description: string;
    NamespacePrefix: string;
    ContainerOptions: string;
    IsOrgDependent: boolean | string;
}

/**
 * Represents installed subscriber package data from InstalledSubscriberPackage
 */
export interface SubscriberPackage {
    name: string;
    package2Id?: string;
    namespacePrefix?: string;
    subscriberPackageVersionId?: string;
    versionNumber?: string;
    type?: Extract<PackageType, 'Unlocked' | 'Managed'>;
    isOrgDependent?: boolean;
    key?: string;
}

export class PackageService {
    private org: Org;
    private logger: Logger;

    constructor(org: Org, logger: Logger) {
        this.org = org;
        this.logger = logger;
    }

    /**
     * Retrieves all 2GP packages installed in the org
     */
    public async getAllInstalled2GPPackages(): Promise<SubscriberPackage[]> {
        return await this.queryInstalledSubscriberPackages();
    }

    /**
     * Retrieves all managed packages (1GP) in the org
     * Note: Managed packages are 1GP, not 2GP - they are separate concepts
     */
    public async getAllInstalledManagedPackages(): Promise<SubscriberPackage[]> {
        return await this.queryInstalledSubscriberPackages(
            'WHERE SubscriberPackage.NamespacePrefix != null'
        );
    }

    /**
     * List all packages created in DevHub
     * @throws Error if org is not a DevHub
     */
    public async listAllPackages(): Promise<Package2[]> {
        try {
            const isDevHub = await this.org.determineIfDevHubOrg(true);

            if (!isDevHub) {
                throw new Error('Package Type Information can only be fetched from a DevHub');
            }

            const packageQuery =
                'SELECT Id, Name, Description, NamespacePrefix, ContainerOptions, IsOrgDependent ' +
                'FROM Package2 ' +
                'WHERE IsDeprecated != true ' +
                'ORDER BY NamespacePrefix, Name';

            const records = await this.query<Package2>(packageQuery, true);

            // Transform IsOrgDependent to human-readable format
            records.forEach((record) => {
                record.IsOrgDependent =
                    record.ContainerOptions === 'Managed' ? 'N/A' : record.IsOrgDependent === true ? 'Yes' : 'No';
            });

            return records;
        } catch (error) {
            if (error instanceof Error && error.message.includes('DevHub')) {
                throw error;
            }
            this.logger.warn('Unable to list packages from DevHub');
            return [];
        }
    }

    /**
     * Private helper to query InstalledSubscriberPackage
     * @param whereClause - Optional WHERE clause to filter results
     */
    private async queryInstalledSubscriberPackages(
        whereClause?: string
    ): Promise<SubscriberPackage[]> {
        try {
            const query = `
                SELECT SubscriberPackageId, SubscriberPackage.Name, SubscriberPackage.NamespacePrefix,
                       SubscriberPackageVersion.Id, SubscriberPackageVersion.Name,
                       SubscriberPackageVersion.MajorVersion, SubscriberPackageVersion.MinorVersion,
                       SubscriberPackageVersion.PatchVersion, SubscriberPackageVersion.BuildNumber,
                       SubscriberPackageVersion.Package2ContainerOptions,
                       SubscriberPackageVersion.IsOrgDependent
                FROM InstalledSubscriberPackage
                ${whereClause || ''}
                ORDER BY SubscriberPackage.Name
            `;

            const records = await this.query<any>(query, true);
            const packages: SubscriberPackage[] = [];

            records.forEach((record) => {
                const packageVersionNumber = `${record.SubscriberPackageVersion.MajorVersion}.${record.SubscriberPackageVersion.MinorVersion}.${record.SubscriberPackageVersion.PatchVersion}.${record.SubscriberPackageVersion.BuildNumber}`;

                const packageDetails: SubscriberPackage = {
                    name: record.SubscriberPackage.Name,
                    package2Id: record.SubscriberPackageId,
                    namespacePrefix: record.SubscriberPackage.NamespacePrefix,
                    subscriberPackageVersionId: record.SubscriberPackageVersion.Id,
                    versionNumber: packageVersionNumber,
                    type: record.SubscriberPackageVersion.Package2ContainerOptions as Extract<PackageType, 'Unlocked' | 'Managed'>,
                    isOrgDependent: record.SubscriberPackageVersion.IsOrgDependent,
                };

                packages.push(packageDetails);
            });

            return packages;
        } catch (error) {
            this.logger.warn('Unable to fetch installed subscriber packages from org');
            return [];
        }
    }

    /**
     * Private query helper method for package queries
     */
    private async query<T>(query: string, isTooling: boolean): Promise<T[]> {
        const conn = this.org.getConnection();
        let records;

        if (isTooling) {
            records = (await conn.tooling.query(query)).records;
        } else {
            records = (await conn.query(query)).records;
        }

        return records as T[];
    }
}

export default PackageService;
