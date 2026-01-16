import fs from 'fs-extra';
import semver, { ReleaseType } from 'semver';

const NEXT_SUFFIX = '.NEXT';
const LATEST_SUFFIX = '.LATEST';

type CustomReleaseType = semver.ReleaseType | 'custom';

export default class VersionManager  {

    constructor(project: ProjectDefinition) {

    }
    
    projectData: {
        packageDirectories: PackageOutput[];
        [key: string]: unknown;
    };

    projectPackages: Map<string, VersionedPackage>;

    diffChecker: PackageUpdater;

    async execute(): Promise<VersionBumpResult> {

        const tags: Record<string, string> = {
            versionType: this.getVersionType(),
            dryRun: String(this.flags.dryrun),
        };

        try {
            this.validateFlags();

            spinner?.start('Loading project configuration...');
            this.loadProjectData();
            spinner?.succeed('Project configuration loaded');

            spinner?.start('Analyzing packages...');
            const { updatedPackages, updatedDependencies } = await this.updateVersions();
            spinner?.stop();

            // Display results
            if (!this.flags.json) {
                this.displayResults(updatedPackages, updatedDependencies);
            }

            if (!this.flags.dryrun && updatedPackages.length > 0) {
                if (!this.flags.json) {
                    logger.log(''); // Add blank line before success message
                    spinner.start('Saving changes to sfdx-project.json...');
                }
                await this.save();
                spinner?.succeed(colorSuccess('sfdx-project.json updated successfully!\n'));
            } else if (this.flags.dryrun && updatedPackages.length > 0) {
                logger.info(colorKeyMessage('\n[Dry Run] Changes previewed but not saved.'));
            }

            // Track metrics
            const elapsedTime = Date.now() - startTime;
            const packagesUpdatedCounter = telemetry.createCounter(
                'project.version.bump.packages',
                'Number of packages updated'
            );
            packagesUpdatedCounter.add(updatedPackages.length, tags);

            const durationHistogram = telemetry.createHistogram(
                'project.version.bump.duration',
                'Duration of version bump operation'
            );
            durationHistogram.record(elapsedTime / 1000, tags);

            logger.debug(`Version bump completed in ${elapsedTime}ms`);

            // Return structured data for --json flag
            const result: VersionBumpResult = {
                packagesUpdated: updatedPackages.length,
                packages: updatedPackages.map((pkg) => ({
                    name: pkg.packageName,
                    oldVersion: pkg.currentVersion,
                    newVersion: pkg.newVersion,
                })),
            };

            if (updatedDependencies.length > 0) {
                result.dependencies = updatedDependencies.map((pkg) => ({
                    name: pkg.packageName,
                    oldVersion: pkg.currentVersion,
                    newVersion: pkg.newVersion,
                    dependencies: pkg.dependencies
                        .filter((dep) => dep.isUpdated)
                        .map((dep) => ({
                            name: dep.packageName,
                            oldVersion: dep.currentVersion,
                            newVersion: dep.newVersion,
                        })),
                }));
            }

            return result;
        } catch (error) {
            spinner?.fail((error as Error).message);

            const errorCounter = telemetry.createCounter('project.version.bump.error', 'Version bump errors');
            errorCounter.add(1, { ...tags, error: (error as Error).message });

            logger.error(`Version bump failed: ${(error as Error).message}`);
            throw error;
        }
    }

    private displayResults(updatedPackages: VersionedPackage[], updatedDependencies: VersionedPackage[]): void {
        if (updatedPackages.length === 0) {
            logger.info(colorKeyMessage('\nNo package versions to update.'));
            return;
        }

        logger.log('\n' + colorKeyMessage('Package versions updated:'));

        updatedPackages.forEach((pkg) => {
            logger.log(`  ${pkg.print({ includeName: true, nameWidth: 30 })}`);
        });

        if (updatedDependencies.length > 0) {
            logger.log('\n' + colorKeyMessage('Dependencies updated:'));

            updatedDependencies.forEach((pkg) => {
                // Only show the package if it or its dependencies were actually updated
                if (!pkg.isUpdated && !pkg.dependencies.some((dep) => dep.isUpdated)) {
                    return;
                }

                if (pkg.isUpdated) {
                    logger.log(`\n${chalk.bold(pkg.packageName)}: ${pkg.print()}`);
                } else {
                    logger.log(`\n${chalk.bold(pkg.packageName)}`);
                }

                const updatedDeps = pkg.dependencies.filter((dep) => dep.isUpdated);
                if (updatedDeps.length > 0) {
                    updatedDeps.forEach((dep, index, array) => {
                        const isLast = index === array.length - 1;
                        const prefix = isLast ? '└─' : '├─';
                        logger.log(`  ${chalk.dim(prefix)} ${dep.packageName}: ${dep.print()}`);
                    });
                }
            });
        }
    }

    protected validateFlags(): void {
        // Ensure only one update strategy is specified
        const strategies = [this.flags.package, this.flags.all, this.flags.targetref, this.flags.targetorg].filter(
            Boolean
        );
        if (strategies.length === 0) {
            throw new Error('Please specify one of: --package, --all, --targetref, or --targetorg');
        }
        if (strategies.length > 1) {
            throw new Error('Please specify only one of: --package, --all, --targetref, or --targetorg');
        }

        // Ensure only one version type is specified
        const versionTypes = [this.flags.patch, this.flags.minor, this.flags.major, this.flags.versionnumber].filter(
            Boolean
        );
        if (versionTypes.length > 1) {
            throw new Error('Please specify only one version type: --patch, --minor, --major, or --versionnumber');
        }
    }

    getVersionType(): CustomReleaseType {
        if (this.flags.minor) {
            return 'minor';
        }

        if (this.flags.major) {
            return 'major';
        }

        if (this.flags.versionnumber) {
            return 'custom';
        }

        return 'patch';
    }

    loadProjectData() {
        const projectPath = this.flags.projectfile === 'sfdx-project.json' ? null : this.flags.projectfile;
        this.projectData = ProjectConfig.getSFDXProjectConfig(projectPath);

        this.projectPackages = new Map(
            this.projectData.packageDirectories.map(
                (pkg: {
                    package: string;
                    versionNumber: string;
                    dependencies?: { package: string; versionNumber: string }[];
                    path?: string;
                }) => [pkg.package, new VersionedPackage(pkg)]
            )
        );
    }

    private async updateVersions(): Promise<{
        updatedPackages: VersionedPackage[];
        updatedDependencies: VersionedPackage[];
    }> {
        const updatedPackages = await this.getDiffChecker().getUpdatedPackages(
            this.getVersionType(),
            this.flags.versionnumber
        );

        const updatedDependencies = this.updateDependencies(updatedPackages);

        return { updatedPackages, updatedDependencies };
    }

    public getDiffChecker(): PackageUpdater {
        let diffChecker: PackageUpdater = null;

        if (this.flags.targetref) {
            diffChecker = new GitDiff(this.flags.targetref, Array.from(this.projectPackages.values()));
        } else if (this.flags.targetorg) {
            diffChecker = new OrgDiff(this.flags.targetorg, Array.from(this.projectPackages.values()));
        } else if (this.flags.package) {
            diffChecker = new SinglePackageUpdate(this.flags.package, Array.from(this.projectPackages.values()));
        } else if (this.flags.all) {
            diffChecker = new AllPackageUpdate(Array.from(this.projectPackages.values()));
        }

        if (!diffChecker) {
            throw new Error('Please specify --package, --all, --targetref, or --targetorg.');
        }

        return diffChecker;
    }

    // Get package by name
    public getPackage(packageName: string): VersionedPackage {
        return this.projectPackages.get(packageName);
    }

    /**
     * Update dependencies based on updated packages
     *
     * @param updatedPackages List of updated packages
     */
    public updateDependencies(updatedPackages: VersionedPackage[]): VersionedPackage[] {
        const updatedDependencies: VersionedPackage[] = [];

        for (const updatedPackage of updatedPackages) {
            this.projectPackages.forEach((projectPackage) => {
                const dependency = projectPackage.updateDependency(updatedPackage);

                if (dependency === null) {
                    return;
                }

                updatedDependencies.push(projectPackage);
            });
        }

        return updatedDependencies;
    }

    public async save() {
        const projectPackages = Array.from(this.projectPackages.values());

        this.projectData.packageDirectories = this.projectData.packageDirectories.map((pkg) => {
            const updatedPkg = projectPackages.find((projectPackage) => projectPackage.packageName === pkg.package);
            return updatedPkg ? { ...pkg, ...updatedPkg.write() } : pkg;
        });

        fs.writeFileSync(this.flags.projectfile, JSON.stringify(this.projectData, null, 2));
    }
}

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