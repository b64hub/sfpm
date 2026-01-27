import { ProjectDefinition, PackageDefinition } from '../types/project.js';

export interface DependencyResolution {
    /** All packages to install, organized by installation level */
    levels: PackageNode[][];

    /** All packages that need to be installed (flattened) */
    allPackages: PackageNode[];

    /** Circular dependencies detected, if any */
    circularDependencies: string[][] | null;
}

export class PackageNode {
    public readonly name: string;
    public readonly path: string;
    public readonly definition: PackageDefinition;

    // Graph connections
    public readonly dependencies: Set<PackageNode> = new Set();
    public readonly dependents: Set<PackageNode> = new Set();

    constructor(def: PackageDefinition) {
        this.name = def.package;
        this.path = def.path;
        this.definition = def;
    }

    get version(): string | undefined {
        return this.definition.versionNumber;
    }
}

export class ProjectGraph {
    private nodes: Map<string, PackageNode> = new Map();

    constructor(projectDefinition: ProjectDefinition) {
        this.buildGraph(projectDefinition);
    }

    private buildGraph(projectDefinition: ProjectDefinition) {
        // 1. Create all nodes - filter out entries without a package property and cast to PackageDefinition
        const packages = projectDefinition.packageDirectories
            .filter((pkg): pkg is PackageDefinition => 'package' in pkg && typeof pkg.package === 'string');
        
        for (const pkg of packages) {
            if (this.nodes.has(pkg.package)) {
                continue;
            }
            this.nodes.set(pkg.package, new PackageNode(pkg));
        }

        // 2. Connect dependencies
        this.nodes.forEach(node => {
            if (node.definition.dependencies) {
                node.definition.dependencies.forEach(depDef => {
                    const depNode = this.nodes.get(depDef.package);
                    if (depNode) {
                        node.dependencies.add(depNode);
                        depNode.dependents.add(node);
                    }
                });
            }
        });
    }

    public getNode(packageName: string): PackageNode | undefined {
        return this.nodes.get(packageName);
    }

    public getAllNodes(): PackageNode[] {
        return Array.from(this.nodes.values());
    }

    /**
     * Returns all transitive dependencies of a package, in topological order (roughly).
     * Does not include the package itself.
     */
    public getTransitiveDependencies(packageName: string): PackageDefinition[] {
        const startNode = this.nodes.get(packageName);
        if (!startNode) {
            throw new Error(`Package ${packageName} not found in project graph`);
        }

        const visited = new Set<string>();
        const result: PackageDefinition[] = [];

        const traverse = (node: PackageNode) => {
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
    public resolveDependencies(packageNames: string[]): DependencyResolution {
        // Validate all package names exist
        for (const name of packageNames) {
            if (!this.nodes.has(name)) {
                throw new Error(`Package ${name} not found in project graph`);
            }
        }

        // Collect all dependencies (including transitive)
        const allNodes = this.collectAllDependencies(packageNames);

        // Check for circular dependencies
        const circularDependencies = this.detectCircularDependencies(Array.from(allNodes).map(n => n.name));

        // Calculate installation levels only if there are no circular dependencies
        let levels: PackageNode[][] = [];
        if (circularDependencies === null) {
            levels = this.getInstallationLevels(Array.from(allNodes).map(n => n.name));
        }

        return {
            levels,
            allPackages: Array.from(allNodes),
            circularDependencies
        };
    }

    /**
     * Organizes packages into parallel installation levels using topological sort.
     * Packages in the same level can be installed in parallel.
     * 
     * @param packageNames - Array of package names to organize
     * @returns 2D array where each sub-array represents packages that can be installed in parallel
     * @throws Error if any package name is not found in the graph
     */
    public getInstallationLevels(packageNames: string[]): PackageNode[][] {
        // Validate all package names exist
        for (const name of packageNames) {
            if (!this.nodes.has(name)) {
                throw new Error(`Package ${name} not found in project graph`);
            }
        }

        // Build a set of nodes we're working with
        const nodeSet = new Set<PackageNode>();
        for (const name of packageNames) {
            const node = this.nodes.get(name);
            if (node) {
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
                const remaining = Array.from(nodeSet).filter(n => !processed.has(n));
                throw new Error(
                    `Circular dependency detected. Cannot process packages: ${remaining.map(n => n.name).join(', ')}`
                );
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

    /**
     * Detects circular dependencies in the graph for a given set of packages.
     * Uses DFS with color marking to detect cycles.
     * 
     * @param packageNames - Array of package names to check for circular dependencies
     * @returns Array of circular dependency chains, or null if none found
     * @throws Error if any package name is not found in the graph
     */
    public detectCircularDependencies(packageNames: string[]): string[][] | null {
        // Validate all package names exist
        for (const name of packageNames) {
            if (!this.nodes.has(name)) {
                throw new Error(`Package ${name} not found in project graph`);
            }
        }

        const nodeSet = new Set<PackageNode>();
        for (const name of packageNames) {
            const node = this.nodes.get(name);
            if (node) {
                nodeSet.add(node);
            }
        }

        // Color marking: white (unvisited), gray (in progress), black (completed)
        const color = new Map<PackageNode, 'white' | 'gray' | 'black'>();
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
                    const cycleStartIndex = currentPath.findIndex(n => n === dep);
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

        const traverse = (node: PackageNode) => {
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
            const node = this.nodes.get(name);
            if (node) {
                traverse(node);
            }
        }

        return result;
    }
}
