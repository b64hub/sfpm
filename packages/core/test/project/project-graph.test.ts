import { describe, test, expect } from 'vitest';
import { ProjectGraph } from '../../src/project/project-graph.js';
import { PackageType } from '../../src/types/package.js';
import type { PackageDefinition } from '../../src/types/project.js';

/** Shorthand for creating a simple package entry */
function pkg(name: string, opts: { default?: boolean; dependencies?: Record<string, string>; managedDependencies?: Record<string, string>; path?: string; type?: PackageType; version?: string } = {}): PackageDefinition {
    return {
        name,
        path: opts.path ?? `packages/${name}`,
        type: opts.type ?? PackageType.Unlocked,
        version: opts.version ?? '1.0.0',
        default: opts.default ?? false,
        ...(opts.dependencies && { dependencies: opts.dependencies }),
        ...(opts.managedDependencies && { managedDependencies: opts.managedDependencies }),
    };
}

describe('ProjectGraph', () => {
    test('should build graph nodes correctly', () => {
        const packages = [pkg('pkg-a'), pkg('pkg-b')];
        const graph = ProjectGraph.buildGraph(packages);
        expect(graph.getAllNodes().length).toBe(2);
        expect(graph.getNode('pkg-a')).toBeDefined();
        expect(graph.getNode('pkg-b')).toBeDefined();
    });

    test('should connect dependencies correctly', () => {
        const packages = [
            pkg('pkg-a', { default: true }),
            pkg('pkg-b', { dependencies: { 'pkg-a': '^1.0.0' } }),
        ];
        const graph = ProjectGraph.buildGraph(packages);
        const nodeA = graph.getNode('pkg-a');
        const nodeB = graph.getNode('pkg-b');

        expect(nodeA?.dependents.has(nodeB!)).toBe(true);
        expect(nodeA?.dependencies.size).toBe(0);
        expect(nodeB?.dependencies.has(nodeA!)).toBe(true);
        expect(nodeB?.dependents.size).toBe(0);
    });

    test('should handle circular dependencies gracefully during build', () => {
        const packages = [
            pkg('pkg-a', { dependencies: { 'pkg-b': '^1.0.0' } }),
            pkg('pkg-b', { default: true, dependencies: { 'pkg-a': '^1.0.0' } }),
        ];
        const graph = ProjectGraph.buildGraph(packages);
        const nodeA = graph.getNode('pkg-a');
        const nodeB = graph.getNode('pkg-b');

        expect(nodeA?.dependencies.has(nodeB!)).toBe(true);
        expect(nodeB?.dependencies.has(nodeA!)).toBe(true);
    });

    describe('Dependency Resolution', () => {
        test('should resolve simple linear dependency chain', () => {
            const packages = [
                pkg('pkg-a'),
                pkg('pkg-b', { dependencies: { 'pkg-a': '^1.0.0' } }),
                pkg('pkg-c', { dependencies: { 'pkg-b': '^1.0.0' } }),
            ];
            const graph = ProjectGraph.buildGraph(packages);
            const resolution = graph.resolveDependencies(['pkg-c']);

            expect(resolution.allPackages.length).toBe(3);
            expect(resolution.levels.length).toBe(3);
            expect(resolution.levels[0].map(n => n.name)).toEqual(['pkg-a']);
            expect(resolution.levels[1].map(n => n.name)).toEqual(['pkg-b']);
            expect(resolution.levels[2].map(n => n.name)).toEqual(['pkg-c']);
            expect(resolution.circularDependencies).toBeNull();
        });

        test('should handle parallel dependencies (user example)', () => {
            const packages = [
                pkg('pkg-a'),
                pkg('pkg-b'),
                pkg('pkg-c', { dependencies: { 'pkg-a': '^1.0.0', 'pkg-b': '^1.0.0' } }),
            ];
            const graph = ProjectGraph.buildGraph(packages);
            const resolution = graph.resolveDependencies(['pkg-c']);

            expect(resolution.allPackages.length).toBe(3);
            expect(resolution.levels.length).toBe(2);
            expect(resolution.levels[0].length).toBe(2);
            expect(resolution.levels[0].map(n => n.name).sort()).toEqual(['pkg-a', 'pkg-b']);
            expect(resolution.levels[1].map(n => n.name)).toEqual(['pkg-c']);
            expect(resolution.circularDependencies).toBeNull();
        });

        test('should handle complex parallel scenario (extended user example)', () => {
            const packages = [
                pkg('pkg-a'),
                pkg('pkg-b'),
                pkg('pkg-e'),
                pkg('pkg-c', { dependencies: { 'pkg-a': '^1.0.0', 'pkg-b': '^1.0.0' } }),
                pkg('pkg-d', { dependencies: { 'pkg-e': '^1.0.0', 'pkg-b': '^1.0.0' } }),
            ];
            const graph = ProjectGraph.buildGraph(packages);
            const resolution = graph.resolveDependencies(['pkg-c', 'pkg-d']);

            expect(resolution.allPackages.length).toBe(5);
            expect(resolution.levels.length).toBe(2);
            expect(resolution.levels[0].length).toBe(3);
            expect(resolution.levels[0].map(n => n.name).sort()).toEqual(['pkg-a', 'pkg-b', 'pkg-e']);
            expect(resolution.levels[1].length).toBe(2);
            expect(resolution.levels[1].map(n => n.name).sort()).toEqual(['pkg-c', 'pkg-d']);
            expect(resolution.circularDependencies).toBeNull();
        });

        test('should detect circular dependencies', () => {
            const packages = [
                pkg('pkg-a', { dependencies: { 'pkg-b': '^1.0.0' } }),
                pkg('pkg-b', { dependencies: { 'pkg-c': '^1.0.0' } }),
                pkg('pkg-c', { dependencies: { 'pkg-a': '^1.0.0' } }),
            ];
            const graph = ProjectGraph.buildGraph(packages);
            const resolution = graph.resolveDependencies(['pkg-a']);

            expect(resolution.circularDependencies).not.toBeNull();
            expect(resolution.circularDependencies!.length).toBeGreaterThan(0);
            expect(() => graph.getInstallationLevels(['pkg-a', 'pkg-b', 'pkg-c']))
                .toThrow(/Circular dependency detected/);
        });

        test('should handle package with no dependencies', () => {
            const packages = [pkg('pkg-a')];
            const graph = ProjectGraph.buildGraph(packages);
            const resolution = graph.resolveDependencies(['pkg-a']);

            expect(resolution.allPackages.length).toBe(1);
            expect(resolution.levels.length).toBe(1);
            expect(resolution.levels[0].map(n => n.name)).toEqual(['pkg-a']);
            expect(resolution.circularDependencies).toBeNull();
        });

        test('should handle multiple independent packages', () => {
            const packages = [pkg('pkg-a'), pkg('pkg-b'), pkg('pkg-c')];
            const graph = ProjectGraph.buildGraph(packages);
            const resolution = graph.resolveDependencies(['pkg-a', 'pkg-b', 'pkg-c']);

            expect(resolution.allPackages.length).toBe(3);
            expect(resolution.levels.length).toBe(1);
            expect(resolution.levels[0].length).toBe(3);
            expect(resolution.circularDependencies).toBeNull();
        });

        test('should throw error for non-existent package', () => {
            const packages = [pkg('pkg-a')];
            const graph = ProjectGraph.buildGraph(packages);
            expect(() => graph.resolveDependencies(['pkg-nonexistent']))
                .toThrow(/Package pkg-nonexistent not found/);
        });

        test('should handle deep dependency tree', () => {
            const packages = [
                pkg('pkg-a'),
                pkg('pkg-b', { dependencies: { 'pkg-a': '^1.0.0' } }),
                pkg('pkg-c', { dependencies: { 'pkg-b': '^1.0.0' } }),
                pkg('pkg-d', { dependencies: { 'pkg-c': '^1.0.0' } }),
                pkg('pkg-e', { dependencies: { 'pkg-d': '^1.0.0' } }),
            ];
            const graph = ProjectGraph.buildGraph(packages);
            const resolution = graph.resolveDependencies(['pkg-e']);

            expect(resolution.allPackages.length).toBe(5);
            expect(resolution.levels.length).toBe(5);
        });

        test('should handle diamond dependency pattern', () => {
            const packages = [
                pkg('pkg-a'),
                pkg('pkg-b', { dependencies: { 'pkg-a': '^1.0.0' } }),
                pkg('pkg-c', { dependencies: { 'pkg-a': '^1.0.0' } }),
                pkg('pkg-d', { dependencies: { 'pkg-b': '^1.0.0', 'pkg-c': '^1.0.0' } }),
            ];
            const graph = ProjectGraph.buildGraph(packages);
            const resolution = graph.resolveDependencies(['pkg-d']);

            expect(resolution.allPackages.length).toBe(4);
            expect(resolution.levels.length).toBe(3);
            expect(resolution.levels[0].map(n => n.name)).toEqual(['pkg-a']);
            expect(resolution.levels[1].length).toBe(2);
            expect(resolution.levels[1].map(n => n.name).sort()).toEqual(['pkg-b', 'pkg-c']);
            expect(resolution.levels[2].map(n => n.name)).toEqual(['pkg-d']);
            expect(resolution.circularDependencies).toBeNull();
        });
    });

    describe('detectCircularDependencies', () => {
        test('should return null for acyclic graph', () => {
            const packages = [
                pkg('pkg-a'),
                pkg('pkg-b', { dependencies: { 'pkg-a': '^1.0.0' } }),
            ];
            const graph = ProjectGraph.buildGraph(packages);
            expect(graph.detectCircularDependencies(['pkg-a', 'pkg-b'])).toBeNull();
        });

        test('should detect simple two-node cycle', () => {
            const packages = [
                pkg('pkg-a', { dependencies: { 'pkg-b': '^1.0.0' } }),
                pkg('pkg-b', { dependencies: { 'pkg-a': '^1.0.0' } }),
            ];
            const graph = ProjectGraph.buildGraph(packages);
            const cycles = graph.detectCircularDependencies(['pkg-a', 'pkg-b']);
            expect(cycles).not.toBeNull();
            expect(cycles!.length).toBeGreaterThan(0);
        });

        test('should detect self-dependency', () => {
            const packages = [pkg('pkg-a', { dependencies: { 'pkg-a': '^1.0.0' } })];
            const graph = ProjectGraph.buildGraph(packages);
            const cycles = graph.detectCircularDependencies(['pkg-a']);
            expect(cycles).not.toBeNull();
        });
    });

    describe('Managed Dependencies', () => {
        test('should create managed nodes from managedDependencies with 04t prefix', () => {
            const packages = [
                pkg('apex-utils', {
                    default: true, path: 'src/apex/utils', version: '0.1.1',
                    managedDependencies: { 'Nebula Logger@4.16.0': '04t5Y0000015pGyQAI' },
                }),
            ];
            const graph = ProjectGraph.buildGraph(packages);
            expect(graph.getAllNodes().length).toBe(2);
            const managedNode = graph.getNode('Nebula Logger@4.16.0');
            expect(managedNode).toBeDefined();
            expect(managedNode!.isManaged).toBe(true);
            expect(managedNode!.packageVersionId).toBe('04t5Y0000015pGyQAI');
        });

        test('should not create managed nodes for aliases without 04t prefix', () => {
            const packages = [
                pkg('apex-utils', {
                    default: true, path: 'src/apex/utils', version: '0.1.1',
                    managedDependencies: { 'unknown-dep': '0Ho09000000oABCDE2' },
                }),
            ];
            const graph = ProjectGraph.buildGraph(packages);
            expect(graph.getAllNodes().length).toBe(1);
            expect(graph.getNode('unknown-dep')).toBeUndefined();
        });

        test('should wire managed dependency edges correctly', () => {
            const packages = [
                pkg('apex-utils', {
                    default: true, path: 'src/apex/utils', version: '0.1.1',
                    managedDependencies: { 'Nebula Logger@4.16.0': '04t5Y0000015pGyQAI' },
                }),
            ];
            const graph = ProjectGraph.buildGraph(packages);
            const apexUtils = graph.getNode('apex-utils');
            const nebulaLogger = graph.getNode('Nebula Logger@4.16.0');

            expect(apexUtils!.dependencies.has(nebulaLogger!)).toBe(true);
            expect(nebulaLogger!.dependents.has(apexUtils!)).toBe(true);
            expect(nebulaLogger!.dependencies.size).toBe(0);
        });

        test('should mark project-local packages as not managed', () => {
            const packages = [
                pkg('pkg-a'),
                pkg('pkg-b', { dependencies: { 'pkg-a': '^1.0.0' } }),
            ];
            const graph = ProjectGraph.buildGraph(packages);
            expect(graph.getNode('pkg-a')!.isManaged).toBe(false);
            expect(graph.getNode('pkg-b')!.isManaged).toBe(false);
        });

        test('should include managed dependencies in dependency resolution levels', () => {
            const packages = [
                pkg('apex-utils', {
                    default: true, path: 'src/apex/utils', version: '0.1.1',
                    managedDependencies: { 'Nebula Logger@4.16.0': '04t5Y0000015pGyQAI' },
                }),
            ];
            const graph = ProjectGraph.buildGraph(packages);
            const resolution = graph.resolveDependencies(['apex-utils']);

            expect(resolution.allPackages.length).toBe(2);
            expect(resolution.levels.length).toBe(2);
            expect(resolution.levels[0][0].name).toBe('Nebula Logger@4.16.0');
            expect(resolution.levels[1][0].name).toBe('apex-utils');
        });

        test('should include managed dependencies in transitive dependency resolution', () => {
            const packages = [
                pkg('pkg-a'),
                pkg('pkg-b', {
                    dependencies: { 'pkg-a': '^1.0.0' },
                    managedDependencies: { 'Nebula Logger@4.16.0': '04t5Y0000015pGyQAI' },
                }),
            ];
            const graph = ProjectGraph.buildGraph(packages);
            const deps = graph.getTransitiveDependencies('pkg-b');
            expect(deps.length).toBe(2);
            expect(deps.find(d => d.name === 'Nebula Logger@4.16.0')).toBeDefined();
        });

        test('should handle multiple managed dependencies', () => {
            const packages = [
                pkg('my-app', {
                    default: true, path: 'src/app',
                    managedDependencies: {
                        'Nebula Logger@4.16.0': '04t5Y0000015pGyQAI',
                        'nCino@2.0.0': '04t000000000XXXYYY',
                    },
                }),
            ];
            const graph = ProjectGraph.buildGraph(packages);
            expect(graph.getAllNodes().length).toBe(3);
            const resolution = graph.resolveDependencies(['my-app']);
            expect(resolution.levels[0].length).toBe(2);
            expect(resolution.levels[0].every(n => n.isManaged)).toBe(true);
        });

        test('should handle mixed managed and project dependencies', () => {
            const packages = [
                pkg('core-lib', { path: 'src/core' }),
                pkg('my-app', {
                    default: true, path: 'src/app',
                    dependencies: { 'core-lib': '^1.0.0' },
                    managedDependencies: { 'Nebula Logger@4.16.0': '04t5Y0000015pGyQAI' },
                }),
            ];
            const graph = ProjectGraph.buildGraph(packages);
            expect(graph.getAllNodes().length).toBe(3);
            const resolution = graph.resolveDependencies(['my-app']);
            expect(resolution.levels.length).toBe(2);
            const level0Names = resolution.levels[0].map(n => n.name).sort();
            expect(level0Names).toEqual(['Nebula Logger@4.16.0', 'core-lib']);
        });
    });

    describe('Package Resolver', () => {
        test('should resolve unknown dependencies via resolver callback', () => {
            const packages = [
                pkg('pkg-a', { dependencies: { 'pkg-b': '^1.0.0' } }),
            ];
            const resolver = (name: string) => {
                if (name === 'pkg-b') return pkg('pkg-b');
                return undefined;
            };

            const graph = ProjectGraph.buildGraph(packages, resolver);
            expect(graph.getAllNodes().length).toBe(2);
            expect(graph.getNode('pkg-b')).toBeDefined();

            const nodeA = graph.getNode('pkg-a');
            const nodeB = graph.getNode('pkg-b');
            expect(nodeA?.dependencies.has(nodeB!)).toBe(true);
        });

        test('should resolve transitive dependencies via resolver', () => {
            const packages = [
                pkg('pkg-a', { dependencies: { 'pkg-b': '^1.0.0' } }),
            ];
            const resolver = (name: string) => {
                if (name === 'pkg-b') return pkg('pkg-b', { dependencies: { 'pkg-c': '^1.0.0' } });
                if (name === 'pkg-c') return pkg('pkg-c');
                return undefined;
            };

            const graph = ProjectGraph.buildGraph(packages, resolver);
            expect(graph.getAllNodes().length).toBe(3);

            const resolution = graph.resolveDependencies(['pkg-a']);
            expect(resolution.levels.length).toBe(3);
            expect(resolution.levels[0].map(n => n.name)).toEqual(['pkg-c']);
            expect(resolution.levels[1].map(n => n.name)).toEqual(['pkg-b']);
            expect(resolution.levels[2].map(n => n.name)).toEqual(['pkg-a']);
        });

        test('should resolve managed dependencies from resolver-discovered packages', () => {
            const packages = [
                pkg('pkg-a', { dependencies: { 'pkg-b': '^1.0.0' } }),
            ];
            const resolver = (name: string) => {
                if (name === 'pkg-b') return pkg('pkg-b', {
                    managedDependencies: { 'Nebula Logger@4.16.0': '04t5Y0000015pGyQAI' },
                });
                return undefined;
            };

            const graph = ProjectGraph.buildGraph(packages, resolver);
            expect(graph.getAllNodes().length).toBe(3);
            expect(graph.getNode('Nebula Logger@4.16.0')?.isManaged).toBe(true);
        });

        test('should push discovered packages back to input array', () => {
            const packages = [
                pkg('pkg-a', { dependencies: { 'pkg-b': '^1.0.0' } }),
            ];
            const resolver = (name: string) => {
                if (name === 'pkg-b') return pkg('pkg-b');
                return undefined;
            };

            ProjectGraph.buildGraph(packages, resolver);
            expect(packages.length).toBe(2);
            expect(packages.find(p => p.name === 'pkg-b')).toBeDefined();
        });

        test('should skip dependencies when resolver returns undefined', () => {
            const packages = [
                pkg('pkg-a', { dependencies: { 'pkg-unknown': '^1.0.0' } }),
            ];
            const resolver = () => undefined;

            const graph = ProjectGraph.buildGraph(packages, resolver);
            expect(graph.getAllNodes().length).toBe(1);
            expect(graph.getNode('pkg-a')?.dependencies.size).toBe(0);
        });
    });
});
