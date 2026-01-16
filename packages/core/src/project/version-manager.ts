import semver, { ReleaseType } from 'semver';
import { EventEmitter } from 'events';
import { ProjectDefinition, PackageDefinition, ProjectFileReader } from './types.js';
import { simpleGit } from 'simple-git';
import { ProjectGraph, PackageNode } from './project-graph.js';
import { OrgPackageVersionFetcher } from '../types/org.js';

const NEXT_SUFFIX = '.NEXT';
const LATEST_SUFFIX = '.LATEST';

export type VersionBumpType = 'patch' | 'minor' | 'major' | 'custom';

export interface VersionManagerConfig {
    projectConfig?: ProjectDefinition;
    fileReader?: ProjectFileReader;
}

export interface VersionChange {
    name: string;
    oldVersion: string;
    newVersion: string;
    dependencies?: VersionChange[];
}

export interface VersionUpdateResult {
    packagesUpdated: number;
    packages: VersionChange[];
    dependencies?: VersionChange[]; // Top level packages that had dependencies updated
}

export interface UpdateStrategy {
    getUpdatedPackages(packages: VersionTracker[]): Promise<VersionTracker[]>;
}

export interface UpdateStrategy {
    getUpdatedPackages(packages: VersionTracker[]): Promise<VersionTracker[]>;
}

export declare interface VersionManager {
    on(event: 'loading', listener: () => void): this;
    on(event: 'loaded', listener: (graph: ProjectGraph) => void): this;
    on(event: 'checking', listener: () => void): this;
    on(event: 'checked', listener: (result: VersionUpdateResult) => void): this;
    on(event: 'saving', listener: () => void): this;
    on(event: 'saved', listener: () => void): this;
}

export class VersionManager extends EventEmitter {
    private graph?: ProjectGraph;
    private trackers: Map<string, VersionTracker> = new Map();
    private projectConfig?: ProjectDefinition;
    private fileReader?: ProjectFileReader;

    constructor(config: VersionManagerConfig) {
        super();
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
        this.emit('loading');
        this.projectConfig = await this.fileReader.read();
        this.loadPackages();
        this.emit('loaded', this.graph);
    }

    public async save(): Promise<void> {
        if (!this.fileReader) {
            throw new Error('ProjectFileReader not provided');
        }
        this.emit('saving');
        const updatedConfig = this.getUpdatedProjectConfig();
        await this.fileReader.write(updatedConfig);
        this.projectConfig = updatedConfig;
        this.emit('saved');
    }

    public getGraph(): ProjectGraph | undefined {
        return this.graph;
    }

    private loadPackages() {
        if (!this.projectConfig) return;
        this.graph = new ProjectGraph(this.projectConfig);
        this.trackers.clear();

        this.graph.getAllNodes().forEach(node => {
            this.trackers.set(node.name, new VersionTracker(node));
        });
    }

    /**
     * compute updated versions based on the strategy
     * does NOT apply changes to the source config object yet, but updates the internal VersionTracker state
     */
    async checkUpdates(
        strategy: UpdateStrategy,
        bumpType: VersionBumpType,
        customVersion?: string
    ): Promise<VersionUpdateResult> {
        if (this.trackers.size === 0) {
            throw new Error('Project not loaded. Call load() or provide projectConfig in constructor.');
        }

        this.emit('checking');

        // Reset state
        this.trackers.forEach(p => p.reset());

        // 1. Identify packages to update
        const packagesToUpdate = await strategy.getUpdatedPackages(
            Array.from(this.trackers.values())
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

        this.emit('checked', result);
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
            const tracker = this.trackers.get(pkgDef.package);
            if (tracker && tracker.isUpdated) {
                return tracker.writeToDefinition(pkgDef);
            }
            return pkgDef;
        });
        return newConfig;
    }

    private updateDependencies(updatedPackages: VersionTracker[]): VersionTracker[] {
        const affectedParentPackages = new Set<VersionTracker>();

        // For every updated package, check if any other package has it as dependency
        for (const updatedPkg of updatedPackages) {
            // Use the graph to find dependents efficiently
            updatedPkg.node.dependents.forEach(dependentNode => {
                const potentialParent = this.trackers.get(dependentNode.name);
                if (potentialParent) {
                    // Check if potentialParent depends on updatedPkg (it should, based on graph)
                    const dependencyRef = potentialParent.getDependency(updatedPkg.packageName);
                    if (dependencyRef) {
                        // Update the dependency version in the parent
                        const newDepVersion = updatedPkg.cleanedVersion(updatedPkg.newVersion ?? undefined);
                        potentialParent.updateDependencyVersion(updatedPkg.packageName, newDepVersion);
                        affectedParentPackages.add(potentialParent);
                    }
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
    async getUpdatedPackages(packages: VersionTracker[]): Promise<VersionTracker[]> {
        return packages;
    }
}

export class SinglePackageStrategy implements UpdateStrategy {
    constructor(private packageName: string) { }

    async getUpdatedPackages(packages: VersionTracker[]): Promise<VersionTracker[]> {
        const pkg = packages.find(p => p.packageName === this.packageName);
        if (!pkg) {
            throw new Error(`Package ${this.packageName} not found in project`);
        }
        return [pkg];
    }
}

export class GitDiffStrategy implements UpdateStrategy {
    constructor(private baseRef: string, private gitCwd: string = '.') { }

    async getUpdatedPackages(packages: VersionTracker[]): Promise<VersionTracker[]> {
        const git = simpleGit(this.gitCwd);
        const changedFiles = await git.diff([
            '--name-only',
            this.baseRef
        ]);

        const changedFilesList = changedFiles.split('\n').filter((f: string) => f);

        // Naive implementation: check if file path is within package path
        // This assumes package path is relative to git root or project root
        return packages.filter(pkg => {
            if (!pkg.path) return false;
            // Normalize paths to be sure
            return changedFilesList.some((file: string) => file.startsWith(pkg.path));
        });
    }
}



export class OrgDiffStrategy implements UpdateStrategy {
    constructor(private orgFetcher: OrgPackageVersionFetcher) { }

    async getUpdatedPackages(packages: VersionTracker[]): Promise<VersionTracker[]> {
        const updates: VersionTracker[] = [];

        for (const pkg of packages) {
            if (!pkg.currentVersion) continue;

            const installedVersion = await this.orgFetcher.getInstalledVersion(pkg.packageName);
            if (installedVersion) {
                const currentV = semver.coerce(pkg.currentVersion);
                const installedV = semver.coerce(installedVersion);
                if (currentV && installedV && semver.lte(currentV, installedV)) {
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

export class VersionTracker {
    public readonly node: PackageNode;

    // State
    public newVersion: string | null = null;
    private dependencies: Map<string, string>; // package -> mutable version
    private updatedDependencies: Set<string>;
    private baseVersionOverride: string | null = null;

    constructor(node: PackageNode) {
        this.node = node;

        // Initialize mutable state from node original definition
        this.dependencies = new Map();
        if (node.originalDefinition.dependencies) {
            node.originalDefinition.dependencies.forEach(d => {
                this.dependencies.set(d.package, d.versionNumber);
            });
        }
        this.updatedDependencies = new Set();
    }

    // Proxy properties for backward compatibility and convenience
    get packageName(): string { return this.node.name; }
    get path(): string { return this.node.path; }
    get currentVersion(): string | undefined { return this.node.version; }

    reset() {
        this.newVersion = null;
        this.updatedDependencies.clear();
        this.baseVersionOverride = null;
        // Revert dependencies to original
        this.dependencies.clear();
        if (this.node.originalDefinition.dependencies) {
            this.node.originalDefinition.dependencies.forEach(d => {
                this.dependencies.set(d.package, d.versionNumber);
            });
        }
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

        // Prefer the suffix from the current configuration (e.g. .NEXT), 
        // falling back to the base version's suffix (e.g. .0)
        const suffixSource = this.currentVersion || base;
        this.setNewVersion(next + this.getSuffix(suffixSource));
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

    cleanedVersion(version?: string): string {
        const vToClean = version || this.currentVersion;
        if (!vToClean) return '0.0.0';

        let v = vToClean;
        if (v.endsWith(NEXT_SUFFIX)) {
            v = v.substring(0, v.length - NEXT_SUFFIX.length);
        }
        if (v.endsWith(LATEST_SUFFIX)) {
            v = v.substring(0, v.length - LATEST_SUFFIX.length);
        }
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
        return '.0';
    }

    writeToDefinition(original: PackageDefinition): PackageDefinition {
        const copy = { ...original };
        if (this.newVersion) {
            copy.versionNumber = this.newVersion;
        }

        if (this.updatedDependencies.size > 0 && copy.dependencies) {
            copy.dependencies = copy.dependencies.map(d => {
                if (this.updatedDependencies.has(d.package)) {
                    return { ...d, versionNumber: this.dependencies.get(d.package)! };
                }
                return d;
            });
        }

        return copy;
    }

    toOutput(includeDependencies = false): VersionChange {
        const out: VersionChange = {
            name: this.packageName,
            oldVersion: this.currentVersion || '0.0.0',
            newVersion: this.newVersion || this.currentVersion || '0.0.0'
        };

        if (includeDependencies && this.updatedDependencies.size > 0) {
            out.dependencies = Array.from(this.updatedDependencies).map(depName => ({
                name: depName,
                oldVersion: '?',
                newVersion: this.dependencies.get(depName) || '0.0.0'
            }));
        }

        return out;
    }
}