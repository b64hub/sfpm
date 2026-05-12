import { describe, test, expect } from 'vitest';
import { ProjectGraph } from '../../src/project/project-graph.js';
import type { ProjectDefinitionProvider } from '../../src/project/providers/project-definition-provider.js';
import { PackageType } from '../../src/types/package.js';
import { ProjectDefinition } from '../../src/types/project.js';

/** Wraps a ProjectDefinition in a minimal ProjectDefinitionProvider for testing. */
function asProvider(definition: ProjectDefinition): ProjectDefinitionProvider {
    return { getProjectDefinition: () => definition } as unknown as ProjectDefinitionProvider;
}

/** Shorthand for creating a simple package entry */
function pkg(name: string, opts: { default?: boolean; dependencies?: Record<string, string>; managedDependencies?: Record<string, string>; path?: string; type?: PackageType; version?: string } = {}) {
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
        const mockProject: ProjectDefinition = {
            packages: [
                pkg('pkg-a'),
                pkg('pkg-b'),
            ]
        };

        const graph = new ProjectGraph(asProvider(mockProject));
        expect(graph.getAllNodes().length).toBe(2);
        expect(graph.getNode('pkg-a')).toBeDefined();
        expect(graph.getNode('pkg-b')).toBeDefined();
    });

    test('should connect dependencies correctly', () => {
        const mockProject: ProjectDefinition = {
            packages: [
                pkg('pkg-a', { default: true }),
                pkg('pkg-b', { dependencies: { 'pkg-a': '^1.0.0' } }),
            ]
        };

        const graph = new ProjectGraph(asProvider(mockProject));
        const nodeA = graph.getNode('pkg-a');
        const nodeB = graph.getNode('pkg-b');

        expect(nodeA?.dependents.has(nodeB!)).toBe(true);
        expect(nodeA?.dependencies.size).toBe(0);

        expect(nodeB?.dependencies.has(nodeA!)).toBe(true);
        expect(nodeB?.dependents.size).toBe(0);
    });

    test('should handle circular dependencies gracefully during build', () => {
        const mockProject: ProjectDefinition = {
            packages: [
                pkg('pkg-a', { dependencies: { 'pkg-b': '^1.0.0' } }),
                pkg('pkg-b', { default: true, dependencies: { 'pkg-a': '^1.0.0' } }),
            ]
        };

        const graph = new ProjectGraph(asProvider(mockProject));
        const nodeA = graph.getNode('pkg-a');
        const nodeB = graph.getNode('pkg-b');

        expect(nodeA?.dependencies.has(nodeB!)).toBe(true);
        expect(nodeB?.dependencies.has(nodeA!)).toBe(true);
    });

    describe('Dependency Resolution', () => {
        test('should resolve simple linear dependency chain', () => {
            const mockProject: ProjectDefinition = {
                packages: [
                    pkg('pkg-a'),
                    pkg('pkg-b', { dependencies: { 'pkg-a': '^1.0.0' } }),
                    pkg('pkg-c', { dependencies: { 'pkg-b': '^1.0.0' } }),
                ]
            };

            const graph = new ProjectGraph(asProvider(mockProject));
            const resolution = graph.resolveDependencies(['pkg-c']);

            expect(resolution.allPackages.length).toBe(3);
            expect(resolution.levels.length).toBe(3);
            expect(resolution.levels[0].map(n => n.name)).toEqual(['pkg-a']);
            expect(resolution.levels[1].map(n => n.name)).toEqual(['pkg-b']);
            expect(resolution.levels[2].map(n => n.name)).toEqual(['pkg-c']);
            expect(resolution.circularDependencies).toBeNull();
        });

        test('should handle parallel dependencies (user example)', () => {
            const mockProject: ProjectDefinition = {
                packages: [
                    pkg('pkg-a'),
                    pkg('pkg-b'),
                    pkg('pkg-c', { dependencies: { 'pkg-a': '^1.0.0', 'pkg-b': '^1.0.0' } }),
                ]
            };

            const graph = new ProjectGraph(asProvider(mockProject));
            const resolution = graph.resolveDependencies(['pkg-c']);

            expect(resolution.allPackages.length).toBe(3);
            expect(resolution.levels.length).toBe(2);
            expect(resolution.levels[0].length).toBe(2);
            expect(resolution.levels[0].map(n => n.name).sort()).toEqual(['pkg-a', 'pkg-b']);
            expect(resolution.levels[1].map(n => n.name)).toEqual(['pkg-c']);
            expect(resolution.circularDependencies).toBeNull();
        });

        test('should handle complex parallel scenario (extended user example)', () => {
            const mockProject: ProjectDefinition = {
                packages: [
                    pkg('pkg-a'),
                    pkg('pkg-b'),
                    pkg('pkg-e'),
                    pkg('pkg-c', { dependencies: { 'pkg-a': '^1.0.0', 'pkg-b': '^1.0.0' } }),
                    pkg('pkg-d', { dependencies: { 'pkg-e': '^1.0.0', 'pkg-b': '^1.0.0' } }),
                ]
            };

            const graph = new ProjectGraph(asProvider(mockProject));
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
            const mockProject: ProjectDefinition = {
                packages: [
                    pkg('pkg-a', { dependencies: { 'pkg-b': '^1.0.0' } }),
                    pkg('pkg-b', { dependencies: { 'pkg-c': '^1.0.0' } }),
                    pkg('pkg-c', { dependencies: { 'pkg-a': '^1.0.0' } }),
                ]
            };

            const graph = new ProjectGraph(asProvider(mockProject));
            const resolution = graph.resolveDependencies(['pkg-a']);

            expect(resolution.circularDependencies).not.toBeNull();
            expect(resolution.circularDependencies!.length).toBeGreaterThan(0);

            expect(() => graph.getInstallationLevels(['pkg-a', 'pkg-b', 'pkg-c']))
                .toThrow(/Circular dependency detected/);
        });

        test('should handle package with no dependencies', () => {
            const mockProject: ProjectDefinition = {
                packages: [pkg('pkg-a')]
            };

            const graph = new ProjectGraph(asProvider(mockProject));
            const resolution = graph.resolveDependencies(['pkg-a']);

            expect(resolution.allPackages.length).toBe(1);
            expect(resolution.levels.length).toBe(1);
            expect(resolution.levels[0].map(n => n.name)).toEqual(['pkg-a']);
            expect(resolution.circularDependencies).toBeNull();
        });

        test('should handle multiple independent packages', () => {
            const mockProject: ProjectDefinition = {
                packages: [pkg('pkg-a'), pkg('pkg-b'), pkg('pkg-c')]
            };

            const graph = new ProjectGraph(asProvider(mockProject));
            const resolution = graph.resolveDependencies(['pkg-a', 'pkg-b', 'pkg-c']);

            expect(resolution.allPackages.length).toBe(3);
            expect(resolution.levels.length).toBe(1);
            expect(resolution.levels[0].length).toBe(3);
            expect(resolution.levels[0].map(n => n.name).sort()).toEqual(['pkg-a', 'pkg-b', 'pkg-c']);
            expect(resolution.circularDependencies).toBeNull();
        });

        test('should throw error for non-existent package', () => {
            const mockProject: ProjectDefinition = {
                packages: [pkg('pkg-a')]
            };

            const graph = new ProjectGraph(asProvider(mockProject));
            expect(() => graph.resolveDependencies(['pkg-nonexistent']))
                .toThrow(/Package pkg-nonexistent not found/);
        });

        test('should handle deep dependency tree', () => {
            const mockProject: ProjectDefinition = {
                packages: [
                    pkg('pkg-a'),
                    pkg('pkg-b', { dependencies: { 'pkg-a': '^1.0.0' } }),
                    pkg('pkg-c', { dependencies: { 'pkg-b': '^1.0.0' } }),
                    pkg('pkg-d', { dependencies: { 'pkg-c': '^1.0.0' } }),
                    pkg('pkg-e', { dependencies: { 'pkg-d': '^1.0.0' } }),
                ]
            };

            const graph = new ProjectGraph(asProvider(mockProject));
            const resolution = graph.resolveDependencies(['pkg-e']);

            expect(resolution.allPackages.length).toBe(5);
            expect(resolution.levels.length).toBe(5);
            expect(resolution.levels[0].map(n => n.name)).toEqual(['pkg-a']);
            expect(resolution.levels[1].map(n => n.name)).toEqual(['pkg-b']);
            expect(resolution.levels[2].map(n => n.name)).toEqual(['pkg-c']);
            expect(resolution.levels[3].map(n => n.name)).toEqual(['pkg-d']);
            expect(resolution.levels[4].map(n => n.name)).toEqual(['pkg-e']);
        });

        test('should handle diamond dependency pattern', () => {
            const mockProject: ProjectDefinition = {
                packages: [
                    pkg('pkg-a'),
                    pkg('pkg-b', { dependencies: { 'pkg-a': '^1.0.0' } }),
                    pkg('pkg-c', { dependencies: { 'pkg-a': '^1.0.0' } }),
                    pkg('pkg-d', { dependencies: { 'pkg-b': '^1.0.0', 'pkg-c': '^1.0.0' } }),
                ]
            };

            const graph = new ProjectGraph(asProvider(mockProject));
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
            const mockProject: ProjectDefinition = {
                packages: [
                    pkg('pkg-a'),
                    pkg('pkg-b', { dependencies: { 'pkg-a': '^1.0.0' } }),
                ]
            };

            const graph = new ProjectGraph(asProvider(mockProject));
            const cycles = graph.detectCircularDependencies(['pkg-a', 'pkg-b']);
            expect(cycles).toBeNull();
        });

        test('should detect simple two-node cycle', () => {
            const mockProject: ProjectDefinition = {
                packages: [
                    pkg('pkg-a', { dependencies: { 'pkg-b': '^1.0.0' } }),
                    pkg('pkg-b', { dependencies: { 'pkg-a': '^1.0.0' } }),
                ]
            };

            const graph = new ProjectGraph(asProvider(mockProject));
            const cycles = graph.detectCircularDependencies(['pkg-a', 'pkg-b']);
            expect(cycles).not.toBeNull();
            expect(cycles!.length).toBeGreaterThan(0);
        });

        test('should detect self-dependency', () => {
            const mockProject: ProjectDefinition = {
                packages: [
                    pkg('pkg-a', { dependencies: { 'pkg-a': '^1.0.0' } }),
                ]
            };

            const graph = new ProjectGraph(asProvider(mockProject));
            const cycles = graph.detectCircularDependencies(['pkg-a']);
            expect(cycles).not.toBeNull();
            expect(cycles!.length).toBeGreaterThan(0);
        });
    });

    describe('Managed Dependencies', () => {
        test('should create managed nodes from managedDependencies with 04t prefix', () => {
            const mockProject: ProjectDefinition = {
                packages: [
                    pkg('apex-utils', {
                        default: true,
                        path: 'src/apex/utils',
                        version: '0.1.1',
                        managedDependencies: { 'Nebula Logger@4.16.0': '04t5Y0000015pGyQAI' },
                    }),
                ]
            };

            const graph = new ProjectGraph(asProvider(mockProject));
            expect(graph.getAllNodes().length).toBe(2);

            const managedNode = graph.getNode('Nebula Logger@4.16.0');
            expect(managedNode).toBeDefined();
            expect(managedNode!.isManaged).toBe(true);
            expect(managedNode!.packageVersionId).toBe('04t5Y0000015pGyQAI');
            expect(managedNode!.path).toBeUndefined();
            expect(managedNode!.version).toBeUndefined();
        });

        test('should not create managed nodes for aliases without 04t prefix', () => {
            const mockProject: ProjectDefinition = {
                packages: [
                    pkg('apex-utils', {
                        default: true,
                        path: 'src/apex/utils',
                        version: '0.1.1',
                        managedDependencies: { 'unknown-dep': '0Ho09000000oABCDE2' },
                    }),
                ]
            };

            const graph = new ProjectGraph(asProvider(mockProject));
            expect(graph.getAllNodes().length).toBe(1);
            expect(graph.getNode('unknown-dep')).toBeUndefined();
        });

        test('should wire managed dependency edges correctly', () => {
            const mockProject: ProjectDefinition = {
                packages: [
                    pkg('apex-utils', {
                        default: true,
                        path: 'src/apex/utils',
                        version: '0.1.1',
                        managedDependencies: { 'Nebula Logger@4.16.0': '04t5Y0000015pGyQAI' },
                    }),
                ]
            };

            const graph = new ProjectGraph(asProvider(mockProject));
            const apexUtils = graph.getNode('apex-utils');
            const nebulaLogger = graph.getNode('Nebula Logger@4.16.0');

            expect(apexUtils!.dependencies.has(nebulaLogger!)).toBe(true);
            expect(nebulaLogger!.dependents.has(apexUtils!)).toBe(true);
            expect(nebulaLogger!.dependencies.size).toBe(0);
        });

        test('should mark project-local packages as not managed', () => {
            const mockProject: ProjectDefinition = {
                packages: [
                    pkg('pkg-a'),
                    pkg('pkg-b', { dependencies: { 'pkg-a': '^1.0.0' } }),
                ]
            };

            const graph = new ProjectGraph(asProvider(mockProject));
            expect(graph.getNode('pkg-a')!.isManaged).toBe(false);
            expect(graph.getNode('pkg-b')!.isManaged).toBe(false);
            expect(graph.getNode('pkg-a')!.path).toBe('packages/pkg-a');
        });

        test('should include managed dependencies in dependency resolution levels', () => {
            const mockProject: ProjectDefinition = {
                packages: [
                    pkg('apex-utils', {
                        default: true,
                        path: 'src/apex/utils',
                        version: '0.1.1',
                        managedDependencies: { 'Nebula Logger@4.16.0': '04t5Y0000015pGyQAI' },
                    }),
                ]
            };

            const graph = new ProjectGraph(asProvider(mockProject));
            const resolution = graph.resolveDependencies(['apex-utils']);

            expect(resolution.allPackages.length).toBe(2);
            expect(resolution.levels.length).toBe(2);
            expect(resolution.levels[0].length).toBe(1);
            expect(resolution.levels[0][0].name).toBe('Nebula Logger@4.16.0');
            expect(resolution.levels[0][0].isManaged).toBe(true);
            expect(resolution.levels[1].length).toBe(1);
            expect(resolution.levels[1][0].name).toBe('apex-utils');
        });

        test('should include managed dependencies in transitive dependency resolution', () => {
            const mockProject: ProjectDefinition = {
                packages: [
                    pkg('pkg-a'),
                    pkg('pkg-b', {
                        dependencies: { 'pkg-a': '^1.0.0' },
                        managedDependencies: { 'Nebula Logger@4.16.0': '04t5Y0000015pGyQAI' },
                    }),
                ]
            };

            const graph = new ProjectGraph(asProvider(mockProject));
            const deps = graph.getTransitiveDependencies('pkg-b');

            expect(deps.length).toBe(2);
            const managedDep = deps.find(d => d.name === 'Nebula Logger@4.16.0');
            expect(managedDep).toBeDefined();
        });

        test('should handle multiple managed dependencies', () => {
            const mockProject: ProjectDefinition = {
                packages: [
                    pkg('my-app', {
                        default: true,
                        path: 'src/app',
                        managedDependencies: {
                            'Nebula Logger@4.16.0': '04t5Y0000015pGyQAI',
                            'nCino@2.0.0': '04t000000000XXXYYY',
                        },
                    }),
                ]
            };

            const graph = new ProjectGraph(asProvider(mockProject));
            expect(graph.getAllNodes().length).toBe(3);

            const resolution = graph.resolveDependencies(['my-app']);
            expect(resolution.levels.length).toBe(2);
            expect(resolution.levels[0].length).toBe(2);
            expect(resolution.levels[0].every(n => n.isManaged)).toBe(true);
        });

        test('should handle mixed managed and project dependencies', () => {
            const mockProject: ProjectDefinition = {
                packages: [
                    pkg('core-lib', { path: 'src/core' }),
                    pkg('my-app', {
                        default: true,
                        path: 'src/app',
                        dependencies: { 'core-lib': '^1.0.0' },
                        managedDependencies: { 'Nebula Logger@4.16.0': '04t5Y0000015pGyQAI' },
                    }),
                ]
            };

            const graph = new ProjectGraph(asProvider(mockProject));
            expect(graph.getAllNodes().length).toBe(3);

            const resolution = graph.resolveDependencies(['my-app']);
            expect(resolution.levels.length).toBe(2);

            const level0Names = resolution.levels[0].map(n => n.name).sort();
            expect(level0Names).toEqual(['Nebula Logger@4.16.0', 'core-lib']);
            expect(resolution.levels[1].map(n => n.name)).toEqual(['my-app']);
        });
    });
});
import { describe, test, expect } from 'vitest';
