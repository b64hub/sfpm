import SfpmPackage from "./sfpm-package.js";
import { ArtifactService } from "../artifacts/artifact-service.js";
import { PackageService, SubscriberPackage, Package2 } from "./package-service.js";
import { InstalledArtifact } from '../types/package.js';
import { Logger } from "../types/logger.js";

export default class PackageManager {
    private artifactService: ArtifactService;
    private packageService: PackageService;
    private logger: Logger;

    constructor(artifactService: ArtifactService, packageService: PackageService, logger: Logger) {
        this.logger = logger;
        this.artifactService = artifactService;
        this.packageService = packageService;
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
     * @param sfpmPackage - Package to upsert artifact for
     * @returns Artifact record ID or undefined if failed
     */
    public async upsertArtifactInOrg(sfpmPackage: SfpmPackage): Promise<string | undefined> {
        return await this.artifactService.upsertArtifact(sfpmPackage);
    }

    /**
     * Retrieves all 2GP packages installed in the org
     */
    public async getAllInstalled2GPPackages(): Promise<SubscriberPackage[]> {
        return await this.packageService.getAllInstalled2GPPackages();
    }

    /**
     * Retrieves all managed packages (1GP) in the org
     */
    public async getAllInstalledManagedPackages(): Promise<SubscriberPackage[]> {
        return await this.packageService.getAllInstalledManagedPackages();
    }

    /**
     * List all packages created in DevHub
     * @throws Error if org is not a DevHub
     */
    public async listAllPackages(): Promise<Package2[]> {
        return await this.packageService.listAllPackages();
    }

    /**
     * Return all artifacts including sfpm as well as external unlocked/managed packages
     */
    public async getAllInstalledArtifacts(): Promise<InstalledArtifact[]> {
        try {
            const artifacts = await this.artifactService.getInstalledPackages('Name');
            const installedArtifacts: InstalledArtifact[] = [];
            const installed2GPPackages = await this.packageService.getAllInstalled2GPPackages();

            artifacts.forEach((artifact) => {
                const installedArtifact: InstalledArtifact = {
                    name: artifact.name,
                    version: artifact.version,
                    commitId: artifact.sourceVersion,
                    isInstalledBySfpm: true,
                };

                const packageFound = installed2GPPackages.find((elem) => elem.name === artifact.name);
                if (packageFound) {

                    installedArtifact.subscriberVersion = packageFound.subscriberPackageVersionId;

                    if (packageFound.isOrgDependent) {
                        installedArtifact.type = 'OrgDependent';
                    } else {
                        installedArtifact.type = 'Unlocked';
                    }

                } else {
                    installedArtifact.subscriberVersion = 'N/A';
                    installedArtifact.type = 'Source/Data';
                }
                installedArtifacts.push(installedArtifact);
            });

            // Add 2GP packages that don't have sfpm artifacts
            installed2GPPackages.forEach((installed2GPPackage) => {
                const packageFound = installedArtifacts.find((elem) => elem.name === installed2GPPackage.name);

                if (packageFound) {
                    return;
                }

                const installedArtifact: InstalledArtifact = {
                    name: installed2GPPackage.name,
                    version: installed2GPPackage.versionNumber || 'N/A',
                    commitId: 'N/A',
                };

                if (installed2GPPackage.isOrgDependent) {
                    installedArtifact.type = 'OrgDependent';
                } else if (installed2GPPackage.type?.toString() === 'managed') {
                    installedArtifact.type = 'Managed';
                } else {
                    installedArtifact.type = 'Unlocked';
                }

                installedArtifact.subscriberVersion = installed2GPPackage.subscriberPackageVersionId;
                installedArtifact.isInstalledBySfpm = false;
                installedArtifacts.push(installedArtifact);
            });

            return installedArtifacts;
        } catch (error) {
            this.logger.warn('Unable to fetch all installed artifacts');
            return [];
        }
    }

}
