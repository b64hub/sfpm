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

    constructor(projectConfig: ProjectDefinition) {
        this.buildGraph(projectConfig);
    }

    private buildGraph(config: ProjectDefinition) {
        // 1. Create all nodes
        config.packageDirectories.forEach(pkg => {
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

    // Potentially add topological sort or traversal helpers here
}
