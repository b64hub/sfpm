import {PackageType} from '../types/package.js';
import {
  PackageDefinition,
  SUBSCRIBER_PKG_VERSION_ID_PREFIX,
} from '../types/project.js';
import {stripScope} from '../utils/scope-utils.js';

export interface DependencyResolution {
  /** All packages that need to be installed (flattened) */
  allPackages: PackageNode[];

  /** Circular dependencies detected, if any */
  circularDependencies: null | string[][];

  /** All packages to install, organized by installation level */
  levels: PackageNode[][];
}

export interface GraphQueryOptions {
  /** Include managed (external) packages in results. Defaults to true. */
  includeManaged?: boolean;
}

/**
 * Callback for lazy package resolution. When the graph encounters a dependency
 * not in the initial ProjectDefinition, it calls this to resolve it on demand.
 */
export type PackageResolver = (packageName: string) => PackageDefinition | undefined;

export class PackageNode {
  /** @internal */
  readonly _dependencies: Set<PackageNode> = new Set();
  /** @internal */
  readonly _dependents: Set<PackageNode> = new Set();
  public readonly definition: PackageDefinition;
  /** Whether this is an external/managed package not part of the project source */
  public readonly isManaged: boolean;
  public readonly name: string;
  /** Subscriber package version ID (04t...) for managed packages */
  public readonly packageVersionId?: string;
  public readonly path?: string;

  constructor(def: PackageDefinition) {
    this.name = def.name;
    this.definition = def;
    this.isManaged = def.type === PackageType.Managed;

    if (this.isManaged) {
      this.packageVersionId = def.packageId;
    }

    if (!this.isManaged) {
      this.path = def.path;
    }
  }

  get dependencies(): ReadonlySet<PackageNode> {
    return this._dependencies;
  }

  get dependents(): ReadonlySet<PackageNode> {
    return this._dependents;
  }

  get version(): string | undefined {
    if (this.isManaged) return undefined;
    return this.definition.version;
  }
}

export {ProjectGraph};
export default class ProjectGraph {
  private readonly nodes: Map<string, PackageNode> = new Map();

  private constructor() {}

  public static buildGraph(
    packages: PackageDefinition[],
    packageResolver?: PackageResolver,
  ): ProjectGraph {
    const graph = new ProjectGraph();
    graph.createLocalNodes(packages);
    graph.createManagedNodes(packages);
    const discovered = graph.wireDependencyEdges(packageResolver);

    // Push resolver-discovered sfpm packages back so provider queries find them.
    // Managed package stubs stay internal to the graph — they're handled
    // separately by PackageInstaller.installManagedPackage().
    packages.push(...discovered);

    return graph;
  }

  /**
   * Detects circular dependencies in the graph for a given set of packages.
   * Uses DFS with color marking to detect cycles.
   *
   * @param packageNames - Array of package names to check for circular dependencies
   * @returns Array of circular dependency chains, or null if none found
   * @throws Error if any package name is not found in the graph
   */
  public detectCircularDependencies(packageNames: string[]): null | string[][] {
    // Validate all package names exist
    for (const name of packageNames) {
      if (!this.resolveNode(name)) {
        throw new Error(`Package ${name} not found in project graph`);
      }
    }

    const nodeSet = new Set<PackageNode>();
    for (const name of packageNames) {
      const node = this.resolveNode(name);
      if (node) {
        nodeSet.add(node);
      }
    }

    // Color marking: white (unvisited), gray (in progress), black (completed)
    const color = new Map<PackageNode, 'black' | 'gray' | 'white'>();
    const cycles: string[][] = [];
    const currentPath: PackageNode[] = [];

    // Initialize all nodes as white
    for (const node of nodeSet) {
      color.set(node, 'white');
    }

    const dfs = (node: PackageNode): void => {
      color.set(node, 'gray');
      currentPath.push(node);

      // Visit all dependencies within our set
      for (const dep of node.dependencies) {
        if (!nodeSet.has(dep)) {
          continue; // Skip dependencies outside our set
        }

        const depColor = color.get(dep);

        if (depColor === 'gray') {
          // Found a cycle! Extract the cycle from currentPath
          const cycleStartIndex = currentPath.indexOf(dep);
          const cycle = currentPath.slice(cycleStartIndex).map(n => n.name);
          cycle.push(dep.name); // Complete the cycle
          cycles.push(cycle);
        } else if (depColor === 'white') {
          dfs(dep);
        }
      }

      currentPath.pop();
      color.set(node, 'black');
    };

    // Run DFS from all unvisited nodes
    for (const node of nodeSet) {
      if (color.get(node) === 'white') {
        dfs(node);
      }
    }

    return cycles.length > 0 ? cycles : null;
  }

  public getAllNodes(): PackageNode[] {
    return [...this.nodes.values()];
  }

  /**
   * Organizes packages into parallel installation levels using topological sort.
   * Packages in the same level can be installed in parallel.
   *
   * @param packageNames - Array of package names to organize
   * @returns 2D array where each sub-array represents packages that can be installed in parallel
   * @throws Error if any package name is not found in the graph
   */
  public getInstallationLevels(packageNames: string[], options?: GraphQueryOptions): PackageNode[][] {
    // Validate all package names exist
    for (const name of packageNames) {
      if (!this.resolveNode(name)) {
        throw new Error(`Package ${name} not found in project graph`);
      }
    }

    const includeManaged = options?.includeManaged !== false;

    // Build a set of nodes we're working with
    const nodeSet = new Set<PackageNode>();
    for (const name of packageNames) {
      const node = this.resolveNode(name);
      if (node && (includeManaged || !node.isManaged)) {
        nodeSet.add(node);
      }
    }

    // Calculate in-degrees (only counting dependencies within our set)
    const inDegree = new Map<PackageNode, number>();
    for (const node of nodeSet) {
      let count = 0;
      for (const dep of node.dependencies) {
        if (nodeSet.has(dep)) {
          count++;
        }
      }

      inDegree.set(node, count);
    }

    const levels: PackageNode[][] = [];
    const processed = new Set<PackageNode>();

    // Process nodes level by level using Kahn's algorithm
    while (processed.size < nodeSet.size) {
      const currentLevel: PackageNode[] = [];

      // Find all nodes with in-degree 0 (no unprocessed dependencies)
      for (const node of nodeSet) {
        if (!processed.has(node) && inDegree.get(node) === 0) {
          currentLevel.push(node);
        }
      }

      // If no nodes can be processed, we have a circular dependency
      if (currentLevel.length === 0) {
        const remaining = [...nodeSet].filter(n => !processed.has(n));
        throw new Error(`Circular dependency detected. Cannot process packages: ${remaining.map(n => n.name).join(', ')}`);
      }

      // Add current level to results
      levels.push(currentLevel);

      // Mark these nodes as processed and update in-degrees
      for (const node of currentLevel) {
        processed.add(node);

        // Decrement in-degree for all dependents
        for (const dependent of node.dependents) {
          if (nodeSet.has(dependent)) {
            const current = inDegree.get(dependent) || 0;
            inDegree.set(dependent, current - 1);
          }
        }
      }
    }

    return levels;
  }

  public getNode(packageName: string): PackageNode | undefined {
    return this.resolveNode(packageName);
  }

  /**
   * Returns all transitive dependencies of a package, in topological order (roughly).
   * Does not include the package itself.
   */
  public getTransitiveDependencies(packageName: string): PackageDefinition[] {
    const startNode = this.resolveNode(packageName);
    if (!startNode) {
      throw new Error(`Package ${packageName} not found in project graph`);
    }

    const visited = new Set<string>();
    const result: PackageDefinition[] = [];

    const traverse = (node: PackageNode): void => {
      for (const dep of node.dependencies) {
        if (!visited.has(dep.name)) {
          visited.add(dep.name);
          // Add dependencies of this dependency first (bottom-up-ish)
          traverse(dep);
          result.push(dep.definition);
        }
      }
    };

    traverse(startNode);
    return result;
  }

  /**
   * Resolves all dependencies for a given set of packages and organizes them
   * into parallel installation levels.
   *
   * @param packageNames - Array of package names to resolve dependencies for
   * @returns DependencyResolution containing installation levels and circular dependencies
   * @throws Error if any package name is not found in the graph
   */
  public resolveDependencies(packageNames: string[], options?: GraphQueryOptions): DependencyResolution {
    // Validate all package names exist
    for (const name of packageNames) {
      if (!this.resolveNode(name)) {
        throw new Error(`Package ${name} not found in project graph`);
      }
    }

    // Collect all dependencies (including transitive)
    const allNodes = this.collectAllDependencies(packageNames);

    // Check for circular dependencies
    const circularDependencies = this.detectCircularDependencies([...allNodes].map(n => n.name));

    // Calculate installation levels only if there are no circular dependencies
    let levels: PackageNode[][] = [];
    if (circularDependencies === null) {
      levels = this.getInstallationLevels([...allNodes].map(n => n.name), options);
    }

    return {
      allPackages: [...allNodes],
      circularDependencies,
      levels,
    };
  }

  /**
   * Collects all transitive dependencies for a set of packages.
   *
   * @param packageNames - Array of package names to collect dependencies for
   * @returns Set of all PackageNode instances that need to be processed
   * @private
   */
  private collectAllDependencies(packageNames: string[]): Set<PackageNode> {
    const result = new Set<PackageNode>();
    const visited = new Set<string>();

    const traverse = (node: PackageNode): void => {
      if (visited.has(node.name)) {
        return;
      }

      visited.add(node.name);
      result.add(node);

      // Recursively add all dependencies
      for (const dep of node.dependencies) {
        traverse(dep);
      }
    };

    // Start traversal from all requested packages
    for (const name of packageNames) {
      const node = this.resolveNode(name);
      if (node) {
        traverse(node);
      }
    }

    return result;
  }

  private createLocalNodes(packages: PackageDefinition[]): void {
    for (const pkg of packages) {
      if (this.nodes.has(pkg.name)) {
        continue;
      }

      this.nodes.set(pkg.name, new PackageNode(pkg));
    }
  }

  /**
   * Detects managed/external dependencies — packages referenced in a
   * package's managedDependencies that have no local entry.
   * Creates stub PackageDefinition nodes with type=managed.
   */
  private createManagedNodes(packages: PackageDefinition[]): void {
    for (const pkg of packages) {
      if (!pkg.managedDependencies) continue;
      for (const [depName, versionId] of Object.entries(pkg.managedDependencies)) {
        if (this.nodes.has(depName)) continue;

        if (versionId.startsWith(SUBSCRIBER_PKG_VERSION_ID_PREFIX)) {
          const managedDef: PackageDefinition = {
            name: depName,
            packageId: versionId,
            path: '',
            type: PackageType.Managed,
            version: '0.0.0',
          };
          this.nodes.set(depName, new PackageNode(managedDef));
        }
      }
    }
  }

  /**
   * Resolve a node by exact name, falling back to scope-stripped matching.
   * e.g. 'sfpm-artifact' resolves to the node keyed as '@b64hub/sfpm-artifact'.
   */
  private resolveNode(name: string): PackageNode | undefined {
    const exact = this.nodes.get(name);
    if (exact) return exact;
    const stripped = stripScope(name);
    for (const [key, node] of this.nodes) {
      if (stripScope(key) === stripped) return node;
    }

    return undefined;
  }

  /**
   * Wires dependency and dependent edges between nodes.
   * When a dependency is not found and a packageResolver is provided,
   * resolves the package on demand, creates the node, and continues
   * iteratively until all reachable dependencies are wired.
   *
   * Returns any PackageDefinitions discovered via the resolver.
   */
  private wireDependencyEdges(packageResolver?: PackageResolver): PackageDefinition[] {
    const discovered: PackageDefinition[] = [];
    const queue = [...this.nodes.values()].filter(n => !n.isManaged);
    const processed = new Set<string>();

    while (queue.length > 0) {
      const node = queue.shift()!;
      if (processed.has(node.name)) continue;
      processed.add(node.name);

      const def = node.definition;

      // Wire workspace/sfpm dependencies
      if (def.dependencies) {
        for (const depName of Object.keys(def.dependencies)) {
          let depNode = this.resolveNode(depName);

          if (!depNode && packageResolver) {
            const depDef = packageResolver(depName);
            if (depDef) {
              depNode = new PackageNode(depDef);
              this.nodes.set(depDef.name, depNode);
              discovered.push(depDef);

              // Create managed dep nodes for the newly discovered package
              if (depDef.managedDependencies) {
                this.createManagedNodes([depDef]);
              }

              if (!depNode.isManaged) {
                queue.push(depNode);
              }
            }
          }

          if (depNode) {
            node._dependencies.add(depNode);
            depNode._dependents.add(node);
          }
        }
      }

      // Wire managed dependencies
      if (def.managedDependencies) {
        for (const depName of Object.keys(def.managedDependencies)) {
          const depNode = this.resolveNode(depName);
          if (depNode) {
            node._dependencies.add(depNode);
            depNode._dependents.add(node);
          }
        }
      }
    }

    return discovered;
  }
}
