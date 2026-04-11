import {EventEmitter} from 'node:events';
import semver, {ReleaseType} from 'semver';

import {GitService} from '../git/git-service.js';
import {OrgPackageVersionFetcher} from '../types/org.js';
import {PackageDefinition, ProjectDefinition} from '../types/project.js';
import {
  formatVersion as formatVersionUtil,
  getVersionSuffix,
  stripBuildSegment,
  toVersionFormat,
} from '../utils/version-utils.js';
import {PackageNode, ProjectGraph} from './project-graph.js';

const NEXT_SUFFIX = '.NEXT';
const LATEST_SUFFIX = '.LATEST';

export type VersionBumpType = 'custom' | 'major' | 'minor' | 'patch';

export interface VersionChange {
  dependencies?: VersionChange[];
  name: string;
  newVersion: string;
  oldVersion: string;
}

export interface VersionUpdateResult {
  dependencies?: VersionChange[]; // Top level packages that had dependencies updated
  packages: VersionChange[];
  packagesUpdated: number;
}

export interface UpdateStrategy {
  getUpdatedPackages(packages: VersionTracker[]): Promise<VersionTracker[]>;
}

export declare interface VersionManagerEvents {
  on(event: 'checking', listener: () => void): this;
  on(event: 'checked', listener: (result: VersionUpdateResult) => void): this;
}

export class VersionManager extends EventEmitter implements VersionManagerEvents {
  private readonly definition: ProjectDefinition;
  private readonly graph: ProjectGraph;
  private readonly trackers: Map<string, VersionTracker> = new Map();

  constructor(graph: ProjectGraph, definition: ProjectDefinition) {
    super();
    this.graph = graph;
    this.definition = definition;
    for (const node of this.graph.getAllNodes()
    .filter(node => !node.isManaged)) {
      this.trackers.set(node.name, new VersionTracker(node));
    }
  }

  /**
   * Cleans a version string for semver comparison.
   * @deprecated Import `toVersionFormat` from `utils/version-utils.js` and use `toVersionFormat(version, 'semver', { strict: false, resolveTokens: true })`.
   */
  public static cleanVersion(version: string): string {
    return toVersionFormat(version, 'semver', {resolveTokens: true, strict: false});
  }

  /**
   * Creates and initializes a new VersionManager instance.
   *
   * @param graph - A pre-built ProjectGraph
   * @param definition - The ProjectDefinition used to build the graph
   * @returns Fully initialized VersionManager instance
   */
  public static create(graph: ProjectGraph, definition: ProjectDefinition): VersionManager {
    return new VersionManager(graph, definition);
  }

  /**
   * Formats version components into a dot-separated version string.
   * @deprecated Import `formatVersion` from `utils/version-utils.js` instead.
   */
  public static formatVersion(major: number, minor: number, patch: number, build: number): string {
    return formatVersionUtil(major, minor, patch, build);
  }

  /**
   * Normalizes and validates a version string.
   * @deprecated Import `toVersionFormat` from `utils/version-utils.js` and use `toVersionFormat(version, 'semver')`.
   */
  public static normalizeVersion(version: string): string {
    if (!version) return '0.0.0.0'; // Legacy default preserved
    return toVersionFormat(version, 'semver');
  }

  /**
   * Converts an npm/semver-style version to the Salesforce 4-part format.
   * @deprecated Import `toVersionFormat` from `utils/version-utils.js` and use `toVersionFormat(version, 'salesforce')`.
   */
  public static toSalesforceVersion(version: string): string {
    return toVersionFormat(version, 'salesforce');
  }

  /**
   * compute updated versions based on the strategy
   * does NOT apply changes to the source config object yet, but updates the internal VersionTracker state
   */
  public async bump(bumpType: VersionBumpType, options?: {strategy?: UpdateStrategy, version?: string}): Promise<VersionUpdateResult> {
    this.emit('checking');

    const trackers = [...this.trackers.values()];

    // identify trackers via strategy
    let identifiedTrackers: VersionTracker[] = [];
    identifiedTrackers = options?.strategy ? (await options.strategy.getUpdatedPackages(trackers)) : trackers;

    // Apply bump to identified trackers
    for (const t of identifiedTrackers) t.bump(bumpType, options?.version);

    // Propagate updates to dependents
    const affectedDependents = this.updateDependencies(identifiedTrackers);

    const result: VersionUpdateResult = {
      dependencies: affectedDependents.map(t => t.toOutput(true)),
      packages: identifiedTrackers.map(t => t.toOutput()),
      packagesUpdated: identifiedTrackers.length,
    };

    this.emit('checked', result);
    return result;
  }

  public getGraph(): ProjectGraph {
    return this.graph;
  }

  /**
   * Returns a copy of the ProjectDefinition with bumped versions applied.
   * The caller is responsible for persisting the result.
   */
  getUpdatedDefinition(): ProjectDefinition {
    const newConfig = {...this.definition};
    newConfig.packageDirectories = (newConfig.packageDirectories as PackageDefinition[]).map((pkgDef: PackageDefinition) => {
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
      for (const dependentNode of updatedPkg.node.dependents) {
        const potentialParent = this.trackers.get(dependentNode.name);
        if (potentialParent) {
          // Check if potentialParent depends on updatedPkg (it should, based on graph)
          const dependencyRef = potentialParent.getDependency(updatedPkg.packageName);
          if (dependencyRef) {
            // Update the dependency version in the parent.
            // Use the bumped version with a .LATEST suffix so dependents
            // resolve to the latest build of the new version.
            const newDepVersion = updatedPkg.cleanedVersion(updatedPkg.newVersion ?? undefined) + LATEST_SUFFIX;
            potentialParent.updateDependencyVersion(updatedPkg.packageName, newDepVersion);
            affectedParentPackages.add(potentialParent);
          }
        }
      }
    }

    return [...affectedParentPackages];
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
  constructor(private baseRef: string, private gitService: GitService) { }

  async getUpdatedPackages(packages: VersionTracker[]): Promise<VersionTracker[]> {
    const packagePaths = packages
    .map(pkg => pkg.path)
    .filter(Boolean);

    const changedPaths = new Set(await this.gitService.getChangedPackagePaths(this.baseRef, packagePaths));

    if (changedPaths.size === 0) return [];

    return packages.filter(pkg => pkg.path && changedPaths.has(pkg.path));
  }
}

export class OrgDiffStrategy implements UpdateStrategy {
  constructor(private orgFetcher: OrgPackageVersionFetcher) { }

  async getUpdatedPackages(packages: VersionTracker[]): Promise<VersionTracker[]> {
    const updates: VersionTracker[] = [];

    for (const pkg of packages) {
      if (!pkg.currentVersion) continue;

      // eslint-disable-next-line no-await-in-loop
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
  // State
  public newVersion: null | string = null;
  public readonly node: PackageNode;
  private baseVersionOverride: null | string = null;
  private dependencies: Map<string, string>; // package -> mutable version
  private updatedDependencies: Set<string>;

  constructor(node: PackageNode) {
    this.node = node;

    // Initialize mutable state from node original definition
    this.dependencies = new Map();
    this.updatedDependencies = new Set();

    if (this.node.isManaged) {
      return;
    }

    const def = node.definition as PackageDefinition;
    if (def.dependencies) {
      for (const d of def.dependencies) {
        this.dependencies.set(d.package, d.versionNumber ?? '');
      }
    }
  }

  get currentVersion(): string | undefined {
    return this.node.version;
  }

  get isUpdated(): boolean {
    return this.newVersion !== null || this.updatedDependencies.size > 0;
  }

  // Proxy properties for backward compatibility and convenience
  get packageName(): string {
    return this.node.name;
  }

  get path(): string {
    return this.node.path ?? '';
  }

  bump(type: VersionBumpType, customVersion?: string): void {
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

  cleanedVersion(version?: string): string {
    return stripBuildSegment(version || this.currentVersion || '');
  }

  getDependency(pkgName: string): string | undefined {
    return this.dependencies.get(pkgName);
  }

  reset(): void {
    this.newVersion = null;
    this.updatedDependencies.clear();
    this.baseVersionOverride = null;
    // Revert dependencies to original
    this.dependencies.clear();
    if (this.node.isManaged) {
      return;
    }

    const def = this.node.definition as PackageDefinition;
    if (def.dependencies) {
      for (const d of def.dependencies) {
        this.dependencies.set(d.package, d.versionNumber ?? '');
      }
    }
  }

  setBaseVersionForBump(version: string): void {
    this.baseVersionOverride = version;
  }

  toOutput(includeDependencies = false): VersionChange {
    const out: VersionChange = {
      name: this.packageName,
      newVersion: this.newVersion || this.currentVersion || '0.0.0',
      oldVersion: this.currentVersion || '0.0.0',
    };

    if (includeDependencies && this.updatedDependencies.size > 0) {
      out.dependencies = [...this.updatedDependencies].map(depName => ({
        name: depName,
        newVersion: this.dependencies.get(depName) || '0.0.0',
        oldVersion: '?',
      }));
    }

    return out;
  }

  updateDependencyVersion(pkgName: string, newVersion: string): void {
    if (this.dependencies.has(pkgName)) {
      // Check if it's already updated to this?
      this.dependencies.set(pkgName, newVersion);
      this.updatedDependencies.add(pkgName);
    }
  }

  writeToDefinition(original: PackageDefinition): PackageDefinition {
    const copy = {...original};
    if (this.newVersion) {
      copy.versionNumber = this.newVersion;
    }

    if (this.updatedDependencies.size > 0 && copy.dependencies) {
      copy.dependencies = copy.dependencies.map(d => {
        if (this.updatedDependencies.has(d.package)) {
          return {...d, versionNumber: this.dependencies.get(d.package)!};
        }

        return d;
      });
    }

    return copy;
  }

  private cleanVersion(version: string): string {
    return stripBuildSegment(version);
  }

  private getSuffix(version: string): string {
    const suffix = getVersionSuffix(version);
    // Normalise to Salesforce dot-separator for consistency with sfdx-project.json
    if (suffix === '-NEXT') return NEXT_SUFFIX;
    if (suffix === '-LATEST') return LATEST_SUFFIX;
    return suffix || '.0';
  }

  private setNewVersion(version: string) {
    this.newVersion = toVersionFormat(version, 'salesforce');
  }
}
