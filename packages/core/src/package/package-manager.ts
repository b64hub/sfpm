import { Org } from "@salesforce/core";
import SfpmPackage from "./sfpm-package.js";
import { Logger } from "../types/logger.js";
import { ArtifactService } from "../artifacts/artifact-service.js";
import { Package2Detail, InstalledArtifact, PackageTypeInfo } from './types.js';

// TODO: Implement these utilities - stubbed for now
// import { convertUsernameToAlias } from '../utils/AliasList';
// import InstalledPackagesQueryExecutor from './packageQuery/InstalledPackagesQueryExecutor';

export default class PackageManager {
    private artifactService: ArtifactService;
    private logger: Logger;
    private org: Org;

    constructor(org: Org, logger: Logger) {
        this.org = org;
        this.logger = logger;
        this.artifactService = new ArtifactService(org, logger);
    }

    public async getInstalledPackages(): Promise<SfpmPackage[]> {
        // ArtifactService already handles errors and returns empty array on failure
        return await this.artifactService.getInstalledPackages("Name");
    }

    /**
     * Check whether an artifact is installed in a Org
     * @param sfpmPackage - Package to check
     * @returns Object with isInstalled flag and versionNumber if found
     */
    public async isArtifactInstalledInOrg(
        sfpmPackage: SfpmPackage
    ): Promise<{ isInstalled: boolean; versionNumber?: string }> {
        this.logger.debug(`Checking if ${sfpmPackage.name} is installed in the Org.`);
        return await this.artifactService.isArtifactInstalled(sfpmPackage.name, sfpmPackage.version);
    }

    /**
     * Updates or creates information about an artifact in the org
     * @param sfpmPackage - Package to create/update artifact for
     * @returns Artifact record ID or undefined if failed
     */
    public async updateArtifactInOrg(sfpmPackage: SfpmPackage): Promise<string | undefined> {
        return await this.artifactService.createOrUpdateArtifact(sfpmPackage);
    }

    /**
     * Retrieves all packages (recognized by Salesforce) installed in the org
     * TODO: Implement InstalledPackagesQueryExecutor
     */
    public async getAllInstalled2GPPackages(): Promise<Package2Detail[]> {
        // TODO: Implement this method once InstalledPackagesQueryExecutor is available
        this.logger.warn('getAllInstalled2GPPackages not yet implemented - requires InstalledPackagesQueryExecutor');
        return [];

        /*
        const installedPackages: Package2Detail[] = [];
        let records = await InstalledPackagesQueryExecutor.exec(this.org.getConnection());

        records.forEach((record) => {
            let packageVersionNumber = `${record.SubscriberPackageVersion.MajorVersion}.${record.SubscriberPackageVersion.MinorVersion}.${record.SubscriberPackageVersion.PatchVersion}.${record.SubscriberPackageVersion.BuildNumber}`;

            let packageDetails: Package2Detail = {
                name: record.SubscriberPackage.Name,
                package2Id: record.SubscriberPackageId,
                namespacePrefix: record.SubscriberPackage.NamespacePrefix,
                subscriberPackageVersionId: record.SubscriberPackageVersion.Id,
                versionNumber: packageVersionNumber,
                type: record.SubscriberPackageVersion.Package2ContainerOptions,
                isOrgDependent: record.SubscriberPackageVersion.IsOrgDependent,
            };

            installedPackages.push(packageDetails);
        });

        return installedPackages;
        */
    }

    /**
     * Retrieves all managed packages in the org
     */
    public async getAllInstalledManagedPackages(): Promise<Package2Detail[]> {
        const installedPackages = await this.getAllInstalled2GPPackages();
        return installedPackages.filter((installedPackage) => installedPackage.type === 'Managed');
    }

    /**
     * List all the packages created in DevHub, will throw an error if it's not a DevHub
     * TODO: Implement query helper for DevHub packages
     */
    public async listAllPackages(): Promise<PackageTypeInfo[]> {
        // TODO: Implement this method - requires DevHub check and query
        this.logger.warn('listAllPackages not yet implemented - requires DevHub check');
        return [];

        /*
        if (await this.org.determineIfDevHubOrg(true)) {
            const packageQuery =
                'SELECT Id,Name, Description, NamespacePrefix, ContainerOptions, IsOrgDependent ' +
                'FROM Package2 ' +
                'WHERE IsDeprecated != true ' +
                'ORDER BY NamespacePrefix, Name';
            
            let records = await this.artifactService.query<PackageTypeInfo>(packageQuery, this.org.getConnection(), true);
            records.forEach((record) => {
                record.IsOrgDependent =
                    record.ContainerOptions === 'Managed' ? 'N/A' : record.IsOrgDependent === true ? 'Yes' : 'No';
            });

            return records;
        } else {
            throw new Error('Package Type Information can only be fetched from a DevHub');
        }
        */
    }

    /**
     * Get the alias for the org
     * TODO: Implement convertUsernameToAlias utility
     */
    public async getAlias(): Promise<string> {
        // TODO: Implement this method once convertUsernameToAlias is available
        this.logger.warn('getAlias not yet implemented - requires convertUsernameToAlias utility');
        return this.org.getUsername() || 'unknown';

        // return await convertUsernameToAlias(this.org.getUsername());
    }

    /**
     * Return all artifacts including sfpm as well as external unlocked/managed
     * TODO: Implement once getAllInstalled2GPPackages is working
     */
    public async getAllInstalledArtifacts(): Promise<InstalledArtifact[]> {
        // TODO: Implement this method once getAllInstalled2GPPackages is available
        this.logger.warn('getAllInstalledArtifacts not yet implemented - requires getAllInstalled2GPPackages');
        return [];

        /*
        let artifacts = await this.artifactService.getInstalledPackages('Name');
        let installedArtifacts: InstalledArtifact[] = [];
        let installed2GPPackages = await this.getAllInstalled2GPPackages();

        artifacts.forEach((artifact) => {
            let installedArtifact: InstalledArtifact = {
                name: artifact.name,
                version: artifact.version,
                commitId: artifact.sourceVersion,
                isInstalledBysfp: true,
            };
            let packageFound = installed2GPPackages.find((elem) => elem.name == artifact.name);
            if (packageFound) {
                installedArtifact.subscriberVersion = packageFound.subscriberPackageVersionId;
                if (packageFound.isOrgDependent) installedArtifact.type = `OrgDependendent`;
                else installedArtifact.type = `Unlocked`;
            } else {
                installedArtifact.subscriberVersion = `N/A`;
                installedArtifact.type = `Source/Data`;
            }
            installedArtifacts.push(installedArtifact);
        });

        installed2GPPackages.forEach((installed2GPPackage) => {
            let packageFound = installedArtifacts.find((elem) => elem.name == installed2GPPackage.name);
            if (!packageFound) {
                let installedArtifact: InstalledArtifact = {
                    name: installed2GPPackage.name,
                    version: installed2GPPackage.versionNumber!,
                    commitId: `N/A`,
                };
                if (installed2GPPackage.isOrgDependent) installedArtifact.type = `OrgDependendent`;
                else if (installed2GPPackage.type == `Managed`) installedArtifact.type = `Managed`;
                else installedArtifact.type = `Unlocked`;

                installedArtifact.subscriberVersion = installed2GPPackage.subscriberPackageVersionId;
                installedArtifact.isInstalledBysfp = false;
                installedArtifacts.push(installedArtifact);
            }
        });
        return installedArtifacts;
        */
    }
}
