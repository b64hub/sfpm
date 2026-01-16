import semver, { ReleaseType } from 'semver';
import { ProjectDefinition, PackageDefinition } from './types.js';
import { ProjectFileReader } from './project-file-reader.js';
import { simpleGit } from 'simple-git';

const NEXT_SUFFIX = '.NEXT';
const LATEST_SUFFIX = '.LATEST';

export type VersionBumpType = 'patch' | 'minor' | 'major' | 'custom';

export interface VersionManagerConfig {
    projectConfig?: ProjectDefinition;
    fileReader?: ProjectFileReader;
}

export interface PackageOutput {
    name: string;
    oldVersion: string;
    newVersion: string;
    dependencies?: PackageOutput[];
}

export interface VersionUpdateResult {
    packagesUpdated: number;
    packages: PackageOutput[];
    dependencies?: PackageOutput[]; // Top level packages that had dependencies updated
}

export interface UpdateStrategy {
    getUpdatedPackages(packages: VersionedPackage[]): Promise<VersionedPackage[]>;
}

export class VersionManager {
    private projectPackages!: Map<string, VersionedPackage>;
    private projectConfig?: ProjectDefinition;
    private fileReader?: ProjectFileReader;

    constructor(config: VersionManagerConfig) {
        this.projectConfig = config.projectConfig;
        this.fileReader = config.fileReader;
        if (this.projectConfig) {
            this.loadPackages();
        }
    }

    public async load(): Promise<void> {
        if (!this.fileReader) {
            throw new Error('ProjectFileReader not provided');
        }
        this.projectConfig = await this.fileReader.read();
        this.loadPackages();
    }

    public async save(): Promise<void> {
        if (!this.fileReader) {
            throw new Error('ProjectFileReader not provided');
        }
        const updatedConfig = this.getUpdatedProjectConfig();
        await this.fileReader.write(updatedConfig);
        this.projectConfig = updatedConfig;
    }

    private loadPackages() {
        if (!this.projectConfig) return;
        this.projectPackages = new Map(
            this.projectConfig.packageDirectories.map((pkg) => [
                pkg.package,
                new VersionedPackage(pkg),
            ])
        );
    }

    /**
     * compute updated versions based on the strategy
     * does NOT apply changes to the source config object yet, but updates the internal VersionedPackage state
     */
    async checkUpdates(
        strategy: UpdateStrategy,
        bumpType: VersionBumpType,
        customVersion?: string
    ): Promise<VersionUpdateResult> {
        if (!this.projectPackages) {
            throw new Error('Project not loaded. Call load() or provide projectConfig in constructor.');
        }

        // Reset state
        this.projectPackages.forEach(p => p.reset());

        // 1. Identify packages to update
        const packagesToUpdate = await strategy.getUpdatedPackages(
            Array.from(this.projectPackages.values())
        );

        // 2. Apply bumps to those packages
        for (const pkg of packagesToUpdate) {
            pkg.bump(bumpType, customVersion);
        }

        // 3. Propagate updates to dependencies
        const updatedDependencies = this.updateDependencies(packagesToUpdate);

        // 4. Construct result
        const result: VersionUpdateResult = {
            packagesUpdated: packagesToUpdate.length,
            packages: packagesToUpdate.map(p => p.toOutput()),
            dependencies: updatedDependencies.map(p => p.toOutput(true))
        };

        return result;
    }

    /**
     * Returns the modified ProjectDefinition
     */
    getUpdatedProjectConfig(): ProjectDefinition {
        if (!this.projectConfig) {
            throw new Error('Project not loaded');
        }
        const newConfig = { ...this.projectConfig };
        newConfig.packageDirectories = newConfig.packageDirectories.map(pkgDef => {
            const versionedPkg = this.projectPackages.get(pkgDef.package);
            if (versionedPkg && versionedPkg.isUpdated) {
                return versionedPkg.writeToDefinition(pkgDef);
            }
            return pkgDef;
        });
        return newConfig;
    }

    private updateDependencies(updatedPackages: VersionedPackage[]): VersionedPackage[] {
        const affectedParentPackages = new Set<VersionedPackage>();

        // For every updated package, check if any other package has it as dependency
        for (const updatedPkg of updatedPackages) {
            this.projectPackages.forEach((potentialParent) => {
                // Check if potentialParent depends on updatedPkg
                const dependencyRef = potentialParent.getDependency(updatedPkg.packageName);
                if (dependencyRef) {
                    // Update the dependency version in the parent
                    const newDepVersion = updatedPkg.cleanedVersion(updatedPkg.newVersion);
                    potentialParent.updateDependencyVersion(updatedPkg.packageName, newDepVersion);
                    affectedParentPackages.add(potentialParent);
                }
            });
        }

        return Array.from(affectedParentPackages);
    }
}

// -------------------------------------------------------------------------------- //
// Strategies
// -------------------------------------------------------------------------------- //

export class AllPackagesStrategy implements UpdateStrategy {
    async getUpdatedPackages(packages: VersionedPackage[]): Promise<VersionedPackage[]> {
        return packages;
    }
}

export class SinglePackageStrategy implements UpdateStrategy {
    constructor(private packageName: string) { }

    async getUpdatedPackages(packages: VersionedPackage[]): Promise<VersionedPackage[]> {
        const pkg = packages.find(p => p.packageName === this.packageName);
        if (!pkg) {
            throw new Error(`Package ${this.packageName} not found in project`);
        }
        return [pkg];
    }
}

export class GitDiffStrategy implements UpdateStrategy {
    constructor(private baseRef: string, private gitCwd: string = '.') { }

    async getUpdatedPackages(packages: VersionedPackage[]): Promise<VersionedPackage[]> {
        const git = simplegit(this.gitCwd);
        const changedFiles = await git.diff([
            '--name-only',
            this.baseRef
        ]);

        const changedFilesList = changedFiles.split('\n').filter(f => f);

        // Naive implementation: check if file path is within package path
        // This assumes package path is relative to git root or project root
        return packages.filter(pkg => {
            if (!pkg.path) return false;
            // Normalize paths to be sure
            return changedFilesList.some(file => file.startsWith(pkg.path));
        });
    }
}

// Interface for Org interaction to decouple SFPOrg
export interface OrgPackageVersionFetcher {
    getInstalledVersion(packageName: string): Promise<string | null>;
}

export class OrgDiffStrategy implements UpdateStrategy {
    constructor(private orgFetcher: OrgPackageVersionFetcher) { }

    async getUpdatedPackages(packages: VersionedPackage[]): Promise<VersionedPackage[]> {
        const updates: VersionedPackage[] = [];

        for (const pkg of packages) {
            if (!pkg.currentVersion) continue;

            const installedVersion = await this.orgFetcher.getInstalledVersion(pkg.packageName);
            if (installedVersion) {
                // If local version <= installed version, we need a bump
                // Actually, the original logic was:
                // if local (cleaned) <= installed, then BUMP
                if (semver.lte(semver.coerce(pkg.currentVersion), semver.coerce(installedVersion))) {
                    // We will attach the override base version to the package temporarily for this flow
                    pkg.setBaseVersionForBump(installedVersion);
                    updates.push(pkg);
                }
            }
        }
        return updates;
    }
}


// -------------------------------------------------------------------------------- //
// Models
// -------------------------------------------------------------------------------- //

export class VersionedPackage {
    public readonly packageName: string;
    public readonly path: string;
    public readonly currentVersion?: string;

    // State
    public newVersion: string | null = null;
    private dependencies: Map<string, string>; // package -> version
    private updatedDependencies: Set<string>; // names of dependencies that were updated

    private baseVersionOverride: string | null = null;

    constructor(def: PackageDefinition) {
        this.packageName = def.package;
        this.path = def.path;
        this.currentVersion = def.versionNumber;
        this.dependencies = new Map();
        this.updatedDependencies = new Set();

        if (def.dependencies) {
            def.dependencies.forEach(d => {
                this.dependencies.set(d.package, d.versionNumber);
            });
        }
    }

    reset() {
        this.newVersion = null;
        this.updatedDependencies.clear();
        this.baseVersionOverride = null;
    }

    get isUpdated() {
        return this.newVersion !== null;
    }

    setBaseVersionForBump(version: string) {
        this.baseVersionOverride = version;
    }

    bump(type: VersionBumpType, customVersion?: string) {
        if (!this.currentVersion) return; // Can't bump if no version

        if (type === 'custom') {
            if (!customVersion) throw new Error('Custom version required for custom bump type');
            this.setNewVersion(customVersion);
            return;
        }

        const base = this.baseVersionOverride || this.currentVersion;
        const cleaned = this.cleanVersion(base);

        const next = semver.inc(cleaned, type as ReleaseType);
        if (!next) throw new Error(`Failed to increment version ${cleaned} with type ${type}`);

        this.setNewVersion(next + this.getSuffix(base));
    }

    private setNewVersion(version: string) {
        try {
            semver.coerce(version);
            this.newVersion = version;
        } catch {
            throw new Error(`Invalid version: ${version}`);
        }
    }

    updateDependencyVersion(pkgName: string, newVersion: string) {
        if (this.dependencies.has(pkgName)) {
            // Check if it's already updated to this?
            this.dependencies.set(pkgName, newVersion);
            this.updatedDependencies.add(pkgName);
        }
    }

    getDependency(pkgName: string): string | undefined {
        return this.dependencies.get(pkgName);
    }

    cleanedVersion(version: string = this.currentVersion): string {
        if (!version) return '0.0.0';
        // Remove suffixes like .NEXT, .LATEST
        let v = version;
        if (v.endsWith(NEXT_SUFFIX)) v = v.substring(0, v.length - NEXT_SUFFIX.length);
        if (v.endsWith(LATEST_SUFFIX)) v = v.substring(0, v.length - LATEST_SUFFIX.length);
        return v;
    }

    // For internal structure matching original cleaner
    private cleanVersion(version: string): string {
        const parts = version.split('.');
        // Take first 3 parts
        return parts.slice(0, 3).join('.');
    }

    private getSuffix(version: string): string {
        if (version.includes(NEXT_SUFFIX)) return NEXT_SUFFIX;
        if (version.includes(LATEST_SUFFIX)) return LATEST_SUFFIX;
        return '.0'; // Default suffix from original code
    }

    writeToDefinition(original: PackageDefinition): PackageDefinition {
        const copy = { ...original };
        if (this.newVersion) {
            copy.versionNumber = this.newVersion;
        }

        if (this.updatedDependencies.size > 0 && copy.dependencies) {
            copy.dependencies = copy.dependencies.map(d => {
                if (this.updatedDependencies.has(d.package)) {
                    return { ...d, versionNumber: this.dependencies.get(d.package) };
                }
                return d;
            });
        }

        return copy;
    }

    toOutput(includeDependencies = false): PackageOutput {
        const out: PackageOutput = {
            name: this.packageName,
            oldVersion: this.currentVersion,
            newVersion: this.newVersion || this.currentVersion
        };

        if (includeDependencies && this.updatedDependencies.size > 0) {
            out.dependencies = Array.from(this.updatedDependencies).map(depName => ({
                name: depName,
                oldVersion: '?', // We don't track old version of deps in memory easily this way, could improve
                newVersion: this.dependencies.get(depName)
            }));
        }

        return out;
    }
}