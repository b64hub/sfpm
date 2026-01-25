import { Org } from "@salesforce/core";
import { Logger } from "../types/logger.js";
import { PackageType } from "../types/package.js";
import semver from "semver";
import { soql } from "../utils/soql.js";
import { VersionManager } from "../project/version-manager.js";

export interface Package2 {
    Id: string;
    Name: string;
    Description: string;
    NamespacePrefix: string;
    ContainerOptions: string;
    IsOrgDependent: boolean | string;
}

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

export interface Package2Version {
    SubscriberPackageVersionId: string;
    Package2Id: string;
    Package2: Package2;
    IsPasswordProtected: boolean;
    IsReleased: boolean;
    MajorVersion: number;
    MinorVersion: number;
    PatchVersion: number;
    BuildNumber: number;
    CodeCoverage: { apexCodeCoveragePercentage: number };
    HasPassedCodeCoverageCheck: boolean;
    Branch: string;
}

export class PackageService {
    private org: Org;
    private logger: Logger;

    private static readonly PACKAGE2_VERSION_FIELDS = [
        'SubscriberPackageVersionId',
        'Package2Id',
        'Package2.Name',
        'IsPasswordProtected',
        'IsReleased',
        'MajorVersion',
        'MinorVersion',
        'PatchVersion',
        'BuildNumber',
        'CodeCoverage',
        'HasPassedCodeCoverageCheck',
        'Branch',
    ];

    private static readonly PACKAGE2_FIELDS = [
        'Id',
        'Name',
        'Description',
        'NamespacePrefix',
        'ContainerOptions',
        'IsOrgDependent',
    ];

    private static readonly INSTALLED_PACKAGE_FIELDS = [
        'SubscriberPackageId',
        'SubscriberPackage.Name',
        'SubscriberPackage.NamespacePrefix',
        'SubscriberPackageVersion.Id',
        'SubscriberPackageVersion.Name',
        'SubscriberPackageVersion.MajorVersion',
        'SubscriberPackageVersion.MinorVersion',
        'SubscriberPackageVersion.PatchVersion',
        'SubscriberPackageVersion.BuildNumber',
        'SubscriberPackageVersion.Package2ContainerOptions',
        'SubscriberPackageVersion.IsOrgDependent',
    ];

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
            if (!await this.org.determineIfDevHubOrg()) {
                throw new Error('Package Type Information can only be fetched from a DevHub');
            }

            const packageQuery = soql`
                SELECT ${PackageService.PACKAGE2_FIELDS.join(', ')}
                FROM Package2
                WHERE IsDeprecated != true
                ORDER BY NamespacePrefix, Name
            `.trim();

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
     * Fetch Package2 versions by Package2 Id
     * Sorts by semantic version, in descending order
     * @param package2Id
     * @param versionNumber
     * @param isValidatedPackages
     * @returns
     */
    async getPackage2VersionById(
        package2Id: string,
        versionNumber?: string,
        isValidatedPackages?: boolean,
        isReleased?: boolean
    ): Promise<Package2Version[]> {
        if (!(await this.org.determineIfDevHubOrg())) {
            throw new Error('Package2Version Information can only be fetched from a DevHub');
        }

        const whereClauses = [
            `Package2Id = '${package2Id}'`,
            `IsDeprecated = false`
        ];

        if (versionNumber) {
            const semverVersion = semver.coerce(versionNumber);
            if (!semverVersion) {
                throw new Error(`Invalid version number: ${versionNumber}`);
            }

            const [major, minor, patch, build] = versionNumber.split('.');
            if (major) {
                whereClauses.push(`MajorVersion = ${major}`);
            }
            if (minor) {
                whereClauses.push(`MinorVersion = ${minor}`);
            }
            if (patch) {
                whereClauses.push(`PatchVersion = ${patch}`);
            }
            if (build && !isNaN(Number(build))) {
                whereClauses.push(`BuildNumber = ${build}`);
            }
        }

        if (isValidatedPackages) {
            whereClauses.push('ValidationSkipped = false');
        }
        if (isReleased) {
            whereClauses.push('IsReleased = true');
        }

        const query = soql`
            SELECT ${PackageService.PACKAGE2_VERSION_FIELDS.join(', ')}
            FROM Package2Version
            WHERE ${whereClauses.join(' AND ')}
        `.trim();

        try {
            const records = await this.query<Package2Version>(query, true);

            if (records.length > 1) {
                return records.sort((a, b) => {
                    const v1 = VersionManager.formatVersion(a.MajorVersion, a.MinorVersion, a.PatchVersion, a.BuildNumber);
                    const v2 = VersionManager.formatVersion(b.MajorVersion, b.MinorVersion, b.PatchVersion, b.BuildNumber);
                    return semver.rcompare(v1, v2);
                });
            } else {
                return records;
            }
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            this.logger.error(`Unable to fetch package versions for package id: ${package2Id}. Error: ${message}`);
            throw error;
        }
    }

    async getPackageVersionBySubscriberId(subscriberPackageVersionId: string): Promise<Package2Version> {
        const query = soql`
            SELECT ${PackageService.PACKAGE2_VERSION_FIELDS.join(', ')}
            FROM Package2Version
            WHERE SubscriberPackageVersionId = '${subscriberPackageVersionId}'
        `.trim();

        try {
            const records = await this.query<Package2Version>(query, true);
            return records[0];
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            this.logger.error(`Unable to fetch package version for subscriber id: ${subscriberPackageVersionId}. Error: ${message}`);
            throw error;
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
            const query = soql`
                SELECT ${PackageService.INSTALLED_PACKAGE_FIELDS.join(', ')}
                FROM InstalledSubscriberPackage
                ${whereClause || ''}
                ORDER BY SubscriberPackage.Name
            `.trim();

            const records = await this.query<any>(query, true);
            const packages: SubscriberPackage[] = [];

            records.forEach((record) => {
                const packageVersionNumber = VersionManager.formatVersion(
                    record.SubscriberPackageVersion.MajorVersion,
                    record.SubscriberPackageVersion.MinorVersion,
                    record.SubscriberPackageVersion.PatchVersion,
                    record.SubscriberPackageVersion.BuildNumber
                );

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







// async fetchByPackageBranchAndName(
//     packageBranch: string,
//     packageName: string,
//     versionNumber?: string,
//     ): Promise<Package2Version[]> {

//     let query = this.query;

//     let whereClause: string = `where Branch='${packageBranch}' and Package2.Name ='${packageName}' `;
//     if (versionNumber) {
//         // TODO: validate version number
//         const versions = versionNumber.split('.');
//         if (versions[0]) whereClause += `and MajorVersion=${versions[0]} `;
//         if (versions[1]) whereClause += `and MinorVersion=${versions[1]} `;
//         if (versions[2]) whereClause += `and PatchVersion=${versions[2]} `;
//     }
//     query += whereClause;

//     let orderByClause: string = `order by CreatedDate desc`;
//     query += orderByClause;

//     const records = await QueryHelper.query<Package2Version>(query, this.conn, true);
//     return records;

// }



