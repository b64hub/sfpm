import semver, { ReleaseType } from 'semver';
import { EventEmitter } from 'events';
import { ProjectDefinition, PackageDefinition } from '../types/project.js';
import { simpleGit } from 'simple-git';
import { ProjectGraph, PackageNode } from './project-graph.js';
import { OrgPackageVersionFetcher } from '../types/org.js';
import ProjectConfig from './project-config.js';

const NEXT_SUFFIX = '.NEXT';
const LATEST_SUFFIX = '.LATEST';

export type VersionBumpType = 'patch' | 'minor' | 'major' | 'custom';

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

export declare interface VersionManager {
    on(event: 'loading', listener: () => void): this;
    on(event: 'loaded', listener: (graph: ProjectGraph) => void): this;
    on(event: 'checking', listener: () => void): this;
    on(event: 'checked', listener: (result: VersionUpdateResult) => void): this;
    on(event: 'saving', listener: () => void): this;
    on(event: 'saved', listener: () => void): this;
}

export class VersionManager extends EventEmitter {
    private readonly graph: ProjectGraph;
    private readonly trackers: Map<string, VersionTracker> = new Map();
    private readonly projectConfig: ProjectConfig;

    private constructor(projectConfig: ProjectConfig) {
        super();
        this.projectConfig = projectConfig;
        this.emit('loading');
        const definition = this.projectConfig.getProjectDefinition();
        this.graph = new ProjectGraph(definition);
        this.graph.getAllNodes().forEach(node => {
            this.trackers.set(node.name, new VersionTracker(node));
        });
        this.emit('loaded', this.graph);
    }

    /**
     * Creates and initializes a new VersionManager instance.
     * This is the recommended way to create a VersionManager.
     * 
     * @param projectConfig - The ProjectConfig instance to manage versions for
     * @returns Fully initialized VersionManager instance
     */
    public static create(projectConfig: ProjectConfig): VersionManager {
        return new VersionManager(projectConfig);
    }

    public async save(): Promise<void> {
        this.emit('saving');
        const updatedDefinition = this.getUpdatedProjectConfig();
        await this.projectConfig.save(updatedDefinition);
        this.emit('saved');
    }

    public static formatVersion(major: number, minor: number, patch: number, build: number): string {
        return `${major}.${minor}.${patch}.${build}`;
    }

    /**
     * Cleans a version string for semver comparison.
     * Converts Salesforce 4-part format (1.0.0.16) to semver (1.0.0-16).
     * Handles NEXT suffix by converting to 0 for comparison purposes.
     * 
     * Unlike normalizeVersion, this method does not throw on invalid versions
     * and is optimized for version comparison rather than storage.
     * 
     * @param version - Version string in any supported format
     * @returns Semver-compatible version string, or original if cannot be converted
     */
    public static cleanVersion(version: string): string {
        // Already valid semver
        if (semver.valid(version)) {
            return version;
        }

        // Handle Salesforce format: 1.0.0.16 -> 1.0.0-16, 1.0.0.NEXT -> 1.0.0-0
        const sfFormat = /^(\d+)\.(\d+)\.(\d+)\.(\d+|NEXT|LATEST)$/i;
        const sfMatch = version.match(sfFormat);
        if (sfMatch) {
            const [, major, minor, patch, build] = sfMatch;
            const buildNum = build.toUpperCase();
            // Convert NEXT/LATEST to 0 for comparison (they represent unreleased versions)
            const numericBuild = (buildNum === 'NEXT' || buildNum === 'LATEST') ? '0' : build;
            return `${major}.${minor}.${patch}-${numericBuild}`;
        }

        // Return as-is if we can't parse it (let caller handle invalid versions)
        return version;
    }

    /**
     * Normalizes and validates a version string. 
     * Converts 4-part Salesforce versions (major.minor.patch.build) 
     * to a semver compatible format (major.minor.patch-build).
     * @param version 
     * @returns 
     * @throws if the version cannot be parsed or coerced into a valid semver string.
     */
    public static normalizeVersion(version: string): string {
        if (!version) return '0.0.0.0';

        // 1. Check if it's already valid semver
        let valid = semver.valid(version);
        if (valid) {
            return valid;
        }

        // 2. Handle the Salesforce 4-part format strictly
        const segments = version.split('.');
        if (segments.length === 4) {
            const transformed = `${segments[0]}.${segments[1]}.${segments[2]}-${segments[3]}`;
            valid = semver.valid(transformed);
            if (valid) {
                return valid;
            }
        }

        // 3. Attempt to coerce it (handles things like 'v1.0' or just '1')
        const coerced = semver.coerce(version);
        if (coerced) {
            return coerced.version;
        }

        throw new Error(`Invalid version format: ${version}. Expected major.minor.patch.build or valid semver.`);
    }

    public getGraph(): ProjectGraph {
        return this.graph;
    }

    /**
     * compute updated versions based on the strategy
     * does NOT apply changes to the source config object yet, but updates the internal VersionTracker state
     */
    public async bump(bumpType: VersionBumpType, options?: { strategy?: UpdateStrategy, version?: string }): Promise<VersionUpdateResult> {
        this.emit('checking');

        const trackers = Array.from(this.trackers.values());

        // identify trackers via strategy
        let identifiedTrackers: VersionTracker[] = [];
        if (options?.strategy) {
            identifiedTrackers = await options.strategy.getUpdatedPackages(trackers);
        } else {
            // Default strategy: bump all packages
            identifiedTrackers = trackers;
        }

        // Apply bump to identified trackers
        identifiedTrackers.forEach(t => t.bump(bumpType, options?.version));

        // Propagate updates to dependents
        const affectedDependents = this.updateDependencies(identifiedTrackers);

        const result: VersionUpdateResult = {
            packagesUpdated: identifiedTrackers.length,
            packages: identifiedTrackers.map(t => t.toOutput()),
            dependencies: affectedDependents.map(t => t.toOutput(true))
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
        const definition = this.projectConfig.getProjectDefinition();
        const newConfig = { ...definition };
        newConfig.packageDirectories = (newConfig.packageDirectories as any[]).map((pkgDef: any) => {
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
        if (node.definition.dependencies) {
            node.definition.dependencies.forEach((d: any) => {
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
        if (this.node.definition.dependencies) {
            this.node.definition.dependencies.forEach((d: any) => {
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
        this.newVersion = VersionManager.normalizeVersion(version);
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
        let v = version || this.currentVersion;
        if (!v) return '0.0.0';

        // Check for suffixes with both . and -
        const suffixes = [NEXT_SUFFIX, LATEST_SUFFIX, '-NEXT', '-LATEST'];
        for (const suffix of suffixes) {
            if (v.endsWith(suffix)) {
                v = v.substring(0, v.length - suffix.length);
                break;
            }
        }
        return v;
    }

    // For internal structure matching original cleaner
    private cleanVersion(version: string): string {
        const parts = version.split(/[\.-]/);
        // Take first 3 parts
        return parts.slice(0, 3).join('.');
    }

    private getSuffix(version: string): string {
        if (version.includes(NEXT_SUFFIX) || version.includes('-NEXT')) return NEXT_SUFFIX;
        if (version.includes(LATEST_SUFFIX) || version.includes('-LATEST')) return LATEST_SUFFIX;
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