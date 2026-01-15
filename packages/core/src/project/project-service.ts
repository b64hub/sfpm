
import SfpCommand from '../../../SfpCommand';
import Git from '../../../core/git/Git';

import semver, { ReleaseType } from 'semver';
import fs from 'fs-extra';
import SFPOrg from '../../../core/org/SFPOrg';

const NEXT_SUFFIX = '.NEXT';
const LATEST_SUFFIX = '.LATEST';

type CustomReleaseType = semver.ReleaseType | 'custom';

class VersionedPackage {
    packageName: string;
    packageId: string;
    path: string;

    currentVersion: string;
    newVersion: string = null;

    dependencies: VersionedPackage[] = [];

    constructor({
        package: packageName,
        versionNumber,
        dependencies,
        path,
    }: {
        package: string;
        versionNumber?: string;
        dependencies?: { package: string; versionNumber: string }[];
        path?: string;
    }) {
        this.packageName = packageName;
        this.currentVersion = versionNumber;
        this.path = path;

        if (dependencies) {
            this.setDependencies(dependencies);
        }
    }

    public increment(versionType: CustomReleaseType = 'patch', customVersion: string = null): void {
        // Skip if this package doesn't have a version (e.g., using alias)
        if (!this.currentVersion) {
            return;
        }

        if (versionType === 'custom') {
            this.updateVersion(customVersion);
            return;
        }

        this.updateVersion(semver.inc(this.cleanedVersion(), versionType as ReleaseType));
    }

    public updateVersion(version: string): void {
        // Skip if this package doesn't have a version (e.g., using alias)
        if (!this.currentVersion) {
            return;
        }

        // semver.coerce() throw an error if the version is invalid
        try {
            semver.coerce(version);
        } catch {
            throw new Error(`Cannot update with invalid version number: ${version}`);
        }

        if (this.isUpdated) {
            return;
        }

        this.newVersion = version + this.getSuffix();
    }

    get isUpdated() {
        return this.newVersion !== null;
    }

    getSuffix(): string {
        if (!this.currentVersion) {
            return '.0';
        }

        if (this.currentVersion.includes(NEXT_SUFFIX)) {
            return NEXT_SUFFIX;
        }

        if (this.currentVersion.includes(LATEST_SUFFIX)) {
            return LATEST_SUFFIX;
        }

        return '.0';
    }

    /**
     * Remove any suffixes and build numbers from the version number
     * @returns cleaned version number without suffixes
     */
    public versionByParts(rawVersion: string = this.currentVersion): string[] {
        return rawVersion.split('.').slice(0, 3);
    }

    public cleanedVersion(version: string = this.currentVersion): string {
        if (!version) {
            return '0.0.0';
        }
        return this.versionByParts(version).join('.');
    }

    public setDependencies(dependencies: { package: string; versionNumber?: string }[]): void {
        dependencies.forEach((dep) => {
            this.setDependency(dep);
        });
    }

    public setDependency(dependency: { package: string; versionNumber?: string }): void {
        this.dependencies.push(
            new VersionedPackage({
                package: dependency.package,
                versionNumber: dependency.versionNumber,
            })
        );
    }

    public hasDependency(pkg: VersionedPackage): boolean {
        return this.getDependency(pkg) !== null;
    }

    public getDependency(pkg: VersionedPackage): VersionedPackage | null {
        if (!this.dependencies || this.dependencies.length === 0) {
            return null;
        }

        const dependency = this.dependencies.find((dep) => dep.packageName === pkg.packageName);

        return dependency ? dependency : null;
    }

    public updateDependency(parentPackage: VersionedPackage): VersionedPackage | null {
        const dependency = this.getDependency(parentPackage);

        if (dependency === null || dependency.isUpdated) {
            return null;
        }

        dependency.updateVersion(this.cleanedVersion(parentPackage.newVersion));
        return dependency;
    }

    public print(options: { includeName?: boolean; nameWidth?: number; highlightFn?: typeof chalk.yellow.bold } = {}): string {
        const { includeName = false, nameWidth = 30, highlightFn = chalk.yellow.bold } = options;
        
        let output = '';
        
        if (includeName) {
            output = this.packageName.padEnd(nameWidth) + ' ';
        }

        if (!this.isUpdated) {
            const currentVersion = this.formatVersion(this.currentVersion);
            return output + currentVersion;
        }

        const oldParts = this.versionByParts();
        const newParts = this.versionByParts(this.newVersion);

        const formattedOld: string = oldParts
            .map((part, index) => {
                return part !== newParts[index] ? highlightFn(part) : part;
            })
            .join('.');
        const formattedNew: string = this.versionByParts(this.newVersion)
            .map((part, index) => {
                return part === oldParts[index] ? part : highlightFn(part);
            })
            .join('.');

        const versionWidth = includeName ? 12 : 0;
        return output + formattedOld.padEnd(versionWidth) + ' → ' + formattedNew;
    }

    private formatVersion(version: string): string {
        if (!version) {
            return 'N/A';
        }
        return version.split('.').slice(0, 3).join('.');
    }

    public write(): PackageOutput {
        const output: PackageOutput = { package: this.packageName };

        // If no current version, this is likely an alias reference - don't include versionNumber
        if (this.currentVersion === null || this.currentVersion === undefined) {
            if (this.dependencies.length > 0) {
                output.dependencies = this.dependencies.map((dep) => dep.write());
            }
            return output;
        }

        output.versionNumber = this.currentVersion;

        if (this.isUpdated) {
            output.versionNumber = this.newVersion;
        }

        if (this.dependencies.length > 0) {
            output.dependencies = this.dependencies.map((dep) => dep.write());
        }

        return output;
    }
}


interface PackageUpdater {
    getUpdatedPackages(versionType: CustomReleaseType, versionNumber?: string): Promise<VersionedPackage[]>;
}

class OrgDiff implements PackageUpdater {
    targetOrg: string;
    projectPackages: VersionedPackage[];

    constructor(targetOrg: string, projectPackages: VersionedPackage[]) {
        this.targetOrg = targetOrg;
        this.projectPackages = projectPackages;
    }

    /**
     * Check
     */
    async getUpdatedPackages(versionType: CustomReleaseType, _versionNumber?: string): Promise<VersionedPackage[]> {
        try {
            const org = await SFPOrg.create({ aliasOrUsername: this.targetOrg });
            const installedPackages = await org.getAllInstalledArtifacts();

            const updatedPackages = this.projectPackages
                .map((pkg) => {
                    const installedPkg = installedPackages.find(
                        (installedPkg) =>
                            installedPkg.name === pkg.packageName &&
                            semver.lte(semver.coerce(pkg.currentVersion), semver.coerce(installedPkg.version))
                    );

                    if (installedPkg) {
                        pkg.updateVersion(
                            semver.inc(pkg.cleanedVersion(installedPkg.version), versionType as ReleaseType)
                        );
                    }

                    return pkg;
                })
                .filter((pkg) => pkg.isUpdated);

            return updatedPackages;
        } catch (error) {
            throw new Error(`Error running org diff: ${error.message}`);
        }
    }
}

class SinglePackageUpdate implements PackageUpdater {
    packageName: string;
    projectPackages: VersionedPackage[];

    constructor(packageName: string, projectPackages: VersionedPackage[]) {
        this.packageName = packageName;
        this.projectPackages = projectPackages;
    }

    async getUpdatedPackages(versionType: CustomReleaseType, versionNumber?: string): Promise<VersionedPackage[]> {
        const pkg = this.projectPackages.find((pkg) => pkg.packageName === this.packageName);
        if (!pkg) {
            throw new Error(`Package ${this.packageName} not found in sfdx-project.json`);
        }

        pkg.increment(versionType, versionNumber);
        return [pkg];
    }
}

class AllPackageUpdate implements PackageUpdater {
    projectPackages: VersionedPackage[];

    constructor(projectPackages: VersionedPackage[]) {
        this.projectPackages = projectPackages;
    }

    async getUpdatedPackages(versionType: CustomReleaseType, versionNumber?: string): Promise<VersionedPackage[]> {
        return this.projectPackages.map((pkg) => {
            pkg.increment(versionType, versionNumber);
            return pkg;
        });
    }
}