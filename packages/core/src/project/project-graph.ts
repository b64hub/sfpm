import { ProjectDefinition, PackageDefinition } from '../types/project.js';

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
        // 1. Create all nodes
        projectDefinition.packageDirectories.forEach(pkg => {
            if (this.nodes.has(pkg.package)) {
                // Warning? Or overwrite? Assuming unique names for now.
                return;
            }
            this.nodes.set(pkg.package, new PackageNode(pkg));
        });

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
}
