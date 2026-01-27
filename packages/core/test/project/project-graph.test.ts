import { describe, test, expect } from 'vitest';
import { ProjectGraph } from '../../src/project/project-graph.js';
import { ProjectDefinition } from '../../src/types/project.js';

describe('ProjectGraph', () => {
    test('should build graph nodes correctly', () => {
        const mockProject: ProjectDefinition = {
            packageDirectories: [
                { package: 'pkg-a', path: 'packages/pkg-a', default: false },
                { package: 'pkg-b', path: 'packages/pkg-b', default: false }
            ]
        };

        const graph = new ProjectGraph(mockProject);
        expect(graph.getAllNodes().length).toBe(2);
        expect(graph.getNode('pkg-a')).toBeDefined();
        expect(graph.getNode('pkg-b')).toBeDefined();
    });

    test('should connect dependencies correctly', () => {
        const mockProject: ProjectDefinition = {
            packageDirectories: [
                { package: 'pkg-a', path: 'packages/pkg-a', default: true },
                {
                    package: 'pkg-b',
                    path: 'packages/pkg-b',
                    default: false,
                    dependencies: [{ package: 'pkg-a', versionNumber: '1.0.0' }]
                }
            ]
        };

        const graph = new ProjectGraph(mockProject);
        const nodeA = graph.getNode('pkg-a');
        const nodeB = graph.getNode('pkg-b');

        // Check A
        expect(nodeA?.dependents.has(nodeB!)).toBe(true);
        expect(nodeA?.dependencies.size).toBe(0);

        // Check B
        expect(nodeB?.dependencies.has(nodeA!)).toBe(true);
        expect(nodeB?.dependents.size).toBe(0);
    });

    test('should handle circular dependencies gracefully during build', () => {
        // Just ensuring it doesn't crash on construction, though logic might need loop detection later
        const mockProject: ProjectDefinition = {
            packageDirectories: [
                {
                    package: 'pkg-a',
                    path: 'packages/pkg-a',
                    default: false,
                    dependencies: [{ package: 'pkg-b', versionNumber: '1.0.0' }]
                },
                {
                    package: 'pkg-b',
                    path: 'packages/pkg-b',
                    default: true,
                    dependencies: [{ package: 'pkg-a', versionNumber: '1.0.0' }]
                }
            ]
        };

        const graph = new ProjectGraph(mockProject);
        const nodeA = graph.getNode('pkg-a');
        const nodeB = graph.getNode('pkg-b');

        expect(nodeA?.dependencies.has(nodeB!)).toBe(true);
        expect(nodeB?.dependencies.has(nodeA!)).toBe(true);
    });

    describe('Dependency Resolution', () => {
        test('should resolve simple linear dependency chain', () => {
            // A -> B -> C
            const mockProject: ProjectDefinition = {
                packageDirectories: [
                    { package: 'pkg-a', path: 'packages/pkg-a', default: false },
                    {
                        package: 'pkg-b',
                        path: 'packages/pkg-b',
                        default: false,
                        dependencies: [{ package: 'pkg-a' }]
                    },
                    {
                        package: 'pkg-c',
                        path: 'packages/pkg-c',
                        default: false,
                        dependencies: [{ package: 'pkg-b' }]
                    }
                ]
            };

            const graph = new ProjectGraph(mockProject);
            const resolution = graph.resolveDependencies(['pkg-c']);

            expect(resolution.allPackages.length).toBe(3);
            expect(resolution.levels.length).toBe(3);
            expect(resolution.levels[0].map(n => n.name)).toEqual(['pkg-a']);
            expect(resolution.levels[1].map(n => n.name)).toEqual(['pkg-b']);
            expect(resolution.levels[2].map(n => n.name)).toEqual(['pkg-c']);
            expect(resolution.circularDependencies).toBeNull();
        });

        test('should handle parallel dependencies (user example)', () => {
            // C depends on A & B (no dependency between A & B)
            const mockProject: ProjectDefinition = {
                packageDirectories: [
                    { package: 'pkg-a', path: 'packages/pkg-a', default: false },
                    { package: 'pkg-b', path: 'packages/pkg-b', default: false },
                    {
                        package: 'pkg-c',
                        path: 'packages/pkg-c',
                        default: false,
                        dependencies: [
                            { package: 'pkg-a' },
                            { package: 'pkg-b' }
                        ]
                    }
                ]
            };

            const graph = new ProjectGraph(mockProject);
            const resolution = graph.resolveDependencies(['pkg-c']);

            expect(resolution.allPackages.length).toBe(3);
            expect(resolution.levels.length).toBe(2);

            // Level 0 should have A and B (can install in parallel)
            expect(resolution.levels[0].length).toBe(2);
            expect(resolution.levels[0].map(n => n.name).sort()).toEqual(['pkg-a', 'pkg-b']);

            // Level 1 should have C
            expect(resolution.levels[1].map(n => n.name)).toEqual(['pkg-c']);
            expect(resolution.circularDependencies).toBeNull();
        });

        test('should handle complex parallel scenario (extended user example)', () => {
            // C depends on A & B
            // D depends on E & B
            // Expected: Level 0: [A, B, E], Level 1: [C, D]
            const mockProject: ProjectDefinition = {
                packageDirectories: [
                    { package: 'pkg-a', path: 'packages/pkg-a', default: false },
                    { package: 'pkg-b', path: 'packages/pkg-b', default: false },
                    { package: 'pkg-e', path: 'packages/pkg-e', default: false },
                    {
                        package: 'pkg-c',
                        path: 'packages/pkg-c',
                        default: false,
                        dependencies: [
                            { package: 'pkg-a' },
                            { package: 'pkg-b' }
                        ]
                    },
                    {
                        package: 'pkg-d',
                        path: 'packages/pkg-d',
                        default: false,
                        dependencies: [
                            { package: 'pkg-e' },
                            { package: 'pkg-b' }
                        ]
                    }
                ]
            };

            const graph = new ProjectGraph(mockProject);
            const resolution = graph.resolveDependencies(['pkg-c', 'pkg-d']);

            expect(resolution.allPackages.length).toBe(5);
            expect(resolution.levels.length).toBe(2);

            // Level 0 should have A, B, E (can install in parallel)
            expect(resolution.levels[0].length).toBe(3);
            expect(resolution.levels[0].map(n => n.name).sort()).toEqual(['pkg-a', 'pkg-b', 'pkg-e']);

            // Level 1 should have C and D (can install in parallel)
            expect(resolution.levels[1].length).toBe(2);
            expect(resolution.levels[1].map(n => n.name).sort()).toEqual(['pkg-c', 'pkg-d']);

            expect(resolution.circularDependencies).toBeNull();
        });

        test('should detect circular dependencies', () => {
            // A -> B -> C -> A (circular)
            const mockProject: ProjectDefinition = {
                packageDirectories: [
                    {
                        package: 'pkg-a',
                        path: 'packages/pkg-a',
                        default: false,
                        dependencies: [{ package: 'pkg-b' }]
                    },
                    {
                        package: 'pkg-b',
                        path: 'packages/pkg-b',
                        default: false,
                        dependencies: [{ package: 'pkg-c' }]
                    },
                    {
                        package: 'pkg-c',
                        path: 'packages/pkg-c',
                        default: false,
                        dependencies: [{ package: 'pkg-a' }]
                    }
                ]
            };

            const graph = new ProjectGraph(mockProject);
            const resolution = graph.resolveDependencies(['pkg-a']);

            expect(resolution.circularDependencies).not.toBeNull();
            expect(resolution.circularDependencies!.length).toBeGreaterThan(0);

            // Should throw when trying to get installation levels
            expect(() => graph.getInstallationLevels(['pkg-a', 'pkg-b', 'pkg-c']))
                .toThrow(/Circular dependency detected/);
        });

        test('should handle package with no dependencies', () => {
            const mockProject: ProjectDefinition = {
                packageDirectories: [
                    { package: 'pkg-a', path: 'packages/pkg-a', default: false }
                ]
            };

            const graph = new ProjectGraph(mockProject);
            const resolution = graph.resolveDependencies(['pkg-a']);

            expect(resolution.allPackages.length).toBe(1);
            expect(resolution.levels.length).toBe(1);
            expect(resolution.levels[0].map(n => n.name)).toEqual(['pkg-a']);
            expect(resolution.circularDependencies).toBeNull();
        });

        test('should handle multiple independent packages', () => {
            const mockProject: ProjectDefinition = {
                packageDirectories: [
                    { package: 'pkg-a', path: 'packages/pkg-a', default: false },
                    { package: 'pkg-b', path: 'packages/pkg-b', default: false },
                    { package: 'pkg-c', path: 'packages/pkg-c', default: false }
                ]
            };

            const graph = new ProjectGraph(mockProject);
            const resolution = graph.resolveDependencies(['pkg-a', 'pkg-b', 'pkg-c']);

            expect(resolution.allPackages.length).toBe(3);
            expect(resolution.levels.length).toBe(1);
            expect(resolution.levels[0].length).toBe(3);
            expect(resolution.levels[0].map(n => n.name).sort()).toEqual(['pkg-a', 'pkg-b', 'pkg-c']);
            expect(resolution.circularDependencies).toBeNull();
        });

        test('should throw error for non-existent package', () => {
            const mockProject: ProjectDefinition = {
                packageDirectories: [
                    { package: 'pkg-a', path: 'packages/pkg-a', default: false }
                ]
            };

            const graph = new ProjectGraph(mockProject);

            expect(() => graph.resolveDependencies(['pkg-nonexistent']))
                .toThrow(/Package pkg-nonexistent not found/);
        });

        test('should handle deep dependency tree', () => {
            // A -> B -> C -> D -> E (5 levels deep)
            const mockProject: ProjectDefinition = {
                packageDirectories: [
                    { package: 'pkg-a', path: 'packages/pkg-a', default: false },
                    {
                        package: 'pkg-b',
                        path: 'packages/pkg-b',
                        default: false,
                        dependencies: [{ package: 'pkg-a' }]
                    },
                    {
                        package: 'pkg-c',
                        path: 'packages/pkg-c',
                        default: false,
                        dependencies: [{ package: 'pkg-b' }]
                    },
                    {
                        package: 'pkg-d',
                        path: 'packages/pkg-d',
                        default: false,
                        dependencies: [{ package: 'pkg-c' }]
                    },
                    {
                        package: 'pkg-e',
                        path: 'packages/pkg-e',
                        default: false,
                        dependencies: [{ package: 'pkg-d' }]
                    }
                ]
            };

            const graph = new ProjectGraph(mockProject);
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
            // D depends on B and C, both B and C depend on A
            //     A
            //    / \
            //   B   C
            //    \ /
            //     D
            const mockProject: ProjectDefinition = {
                packageDirectories: [
                    { package: 'pkg-a', path: 'packages/pkg-a', default: false },
                    {
                        package: 'pkg-b',
                        path: 'packages/pkg-b',
                        default: false,
                        dependencies: [{ package: 'pkg-a' }]
                    },
                    {
                        package: 'pkg-c',
                        path: 'packages/pkg-c',
                        default: false,
                        dependencies: [{ package: 'pkg-a' }]
                    },
                    {
                        package: 'pkg-d',
                        path: 'packages/pkg-d',
                        default: false,
                        dependencies: [
                            { package: 'pkg-b' },
                            { package: 'pkg-c' }
                        ]
                    }
                ]
            };

            const graph = new ProjectGraph(mockProject);
            const resolution = graph.resolveDependencies(['pkg-d']);

            expect(resolution.allPackages.length).toBe(4);
            expect(resolution.levels.length).toBe(3);

            // Level 0: A
            expect(resolution.levels[0].map(n => n.name)).toEqual(['pkg-a']);

            // Level 1: B and C (can install in parallel)
            expect(resolution.levels[1].length).toBe(2);
            expect(resolution.levels[1].map(n => n.name).sort()).toEqual(['pkg-b', 'pkg-c']);

            // Level 2: D
            expect(resolution.levels[2].map(n => n.name)).toEqual(['pkg-d']);

            expect(resolution.circularDependencies).toBeNull();
        });
    });

    describe('detectCircularDependencies', () => {
        test('should return null for acyclic graph', () => {
            const mockProject: ProjectDefinition = {
                packageDirectories: [
                    { package: 'pkg-a', path: 'packages/pkg-a', default: false },
                    {
                        package: 'pkg-b',
                        path: 'packages/pkg-b',
                        default: false,
                        dependencies: [{ package: 'pkg-a' }]
                    }
                ]
            };

            const graph = new ProjectGraph(mockProject);
            const cycles = graph.detectCircularDependencies(['pkg-a', 'pkg-b']);

            expect(cycles).toBeNull();
        });

        test('should detect simple two-node cycle', () => {
            const mockProject: ProjectDefinition = {
                packageDirectories: [
                    {
                        package: 'pkg-a',
                        path: 'packages/pkg-a',
                        default: false,
                        dependencies: [{ package: 'pkg-b' }]
                    },
                    {
                        package: 'pkg-b',
                        path: 'packages/pkg-b',
                        default: false,
                        dependencies: [{ package: 'pkg-a' }]
                    }
                ]
            };

            const graph = new ProjectGraph(mockProject);
            const cycles = graph.detectCircularDependencies(['pkg-a', 'pkg-b']);

            expect(cycles).not.toBeNull();
            expect(cycles!.length).toBeGreaterThan(0);
        });

        test('should detect self-dependency', () => {
            const mockProject: ProjectDefinition = {
                packageDirectories: [
                    {
                        package: 'pkg-a',
                        path: 'packages/pkg-a',
                        default: false,
                        dependencies: [{ package: 'pkg-a' }]
                    }
                ]
            };

            const graph = new ProjectGraph(mockProject);
            const cycles = graph.detectCircularDependencies(['pkg-a']);

            expect(cycles).not.toBeNull();
            expect(cycles!.length).toBeGreaterThan(0);
        });
    });
});
