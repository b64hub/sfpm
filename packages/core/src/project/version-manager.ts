import {EventEmitter} from 'node:events';
import semver, {ReleaseType} from 'semver';

import {GitService} from '../git/git-service.js';
import {OrgPackageVersionFetcher} from '../types/org.js';
import {PackageDefinition, ProjectDefinition} from '../types/project.js';
import {
  stripBuildSegment,
} from '../utils/version-utils.js';
import {PackageNode, ProjectGraph} from './project-graph.js';

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
    newConfig.packages = newConfig.packages.map(pkgDef => {
      const tracker = this.trackers.get(pkgDef.name);
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
            // Update the dependency version in the parent to the bumped semver.
            // The adapter layer handles format conversion (e.g. appending .LATEST)
            // when writing to sfdx-project.json.
            const newDepVersion = updatedPkg.cleanedVersion(updatedPkg.newVersion ?? undefined);
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
      for (const [depName, depVersion] of Object.entries(def.dependencies)) {
        this.dependencies.set(depName, depVersion);
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
      this.newVersion = stripBuildSegment(customVersion);
      return;
    }

    const base = this.baseVersionOverride || this.currentVersion;
    const cleaned = stripBuildSegment(base);

    const next = semver.inc(cleaned, type as ReleaseType);
    if (!next) throw new Error(`Failed to increment version ${cleaned} with type ${type}`);

    this.newVersion = next;
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
      for (const [depName, depVersion] of Object.entries(def.dependencies)) {
        this.dependencies.set(depName, depVersion);
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
      this.dependencies.set(pkgName, newVersion);
      this.updatedDependencies.add(pkgName);
    }
  }

  writeToDefinition(original: PackageDefinition): PackageDefinition {
    const copy = {...original};
    if (this.newVersion) {
      copy.version = this.newVersion;
    }

    if (this.updatedDependencies.size > 0 && copy.dependencies) {
      const updatedDeps = {...copy.dependencies};
      for (const depName of this.updatedDependencies) {
        if (depName in updatedDeps) {
          updatedDeps[depName] = this.dependencies.get(depName)!;
        }
      }

      copy.dependencies = updatedDeps;
    }

    return copy;
  }
}
