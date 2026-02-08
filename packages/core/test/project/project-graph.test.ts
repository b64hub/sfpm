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

    describe('Managed Dependencies', () => {
        test('should create managed nodes from packageAliases with 04t prefix', () => {
            const mockProject: ProjectDefinition = {
                packageDirectories: [
                    {
                        package: 'apex-utils',
                        versionName: 'ver 0.1',
                        versionNumber: '0.1.1.NEXT',
                        path: 'src/apex/utils',
                        default: true,
                        dependencies: [
                            { package: 'Nebula Logger@4.16.0' }
                        ]
                    }
                ],
                packageAliases: {
                    'apex-utils': '0Ho09000000oMKJCA2',
                    'Nebula Logger@4.16.0': '04t5Y0000015pGyQAI'
                }
            };

            const graph = new ProjectGraph(mockProject);
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
                packageDirectories: [
                    {
                        package: 'apex-utils',
                        versionNumber: '0.1.1.NEXT',
                        path: 'src/apex/utils',
                        default: true,
                        dependencies: [
                            { package: 'unknown-dep' }
                        ]
                    }
                ],
                packageAliases: {
                    'apex-utils': '0Ho09000000oMKJCA2',
                    'unknown-dep': '0Ho09000000oABCDE2'
                }
            };

            const graph = new ProjectGraph(mockProject);
            expect(graph.getAllNodes().length).toBe(1);
            expect(graph.getNode('unknown-dep')).toBeUndefined();
        });

        test('should wire managed dependency edges correctly', () => {
            const mockProject: ProjectDefinition = {
                packageDirectories: [
                    {
                        package: 'apex-utils',
                        versionNumber: '0.1.1.NEXT',
                        path: 'src/apex/utils',
                        default: true,
                        dependencies: [
                            { package: 'Nebula Logger@4.16.0' }
                        ]
                    }
                ],
                packageAliases: {
                    'apex-utils': '0Ho09000000oMKJCA2',
                    'Nebula Logger@4.16.0': '04t5Y0000015pGyQAI'
                }
            };

            const graph = new ProjectGraph(mockProject);
            const apexUtils = graph.getNode('apex-utils');
            const nebulaLogger = graph.getNode('Nebula Logger@4.16.0');

            expect(apexUtils!.dependencies.has(nebulaLogger!)).toBe(true);
            expect(nebulaLogger!.dependents.has(apexUtils!)).toBe(true);
            expect(nebulaLogger!.dependencies.size).toBe(0);
        });

        test('should mark project-local packages as not managed', () => {
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
            expect(graph.getNode('pkg-a')!.isManaged).toBe(false);
            expect(graph.getNode('pkg-b')!.isManaged).toBe(false);
            expect(graph.getNode('pkg-a')!.path).toBe('packages/pkg-a');
        });

        test('should include managed dependencies in dependency resolution levels', () => {
            const mockProject: ProjectDefinition = {
                packageDirectories: [
                    {
                        package: 'apex-utils',
                        versionNumber: '0.1.1.NEXT',
                        path: 'src/apex/utils',
                        default: true,
                        dependencies: [
                            { package: 'Nebula Logger@4.16.0' }
                        ]
                    }
                ],
                packageAliases: {
                    'apex-utils': '0Ho09000000oMKJCA2',
                    'Nebula Logger@4.16.0': '04t5Y0000015pGyQAI'
                }
            };

            const graph = new ProjectGraph(mockProject);
            const resolution = graph.resolveDependencies(['apex-utils']);

            expect(resolution.allPackages.length).toBe(2);
            expect(resolution.levels.length).toBe(2);

            // Level 0: managed dependency (no deps of its own)
            expect(resolution.levels[0].length).toBe(1);
            expect(resolution.levels[0][0].name).toBe('Nebula Logger@4.16.0');
            expect(resolution.levels[0][0].isManaged).toBe(true);

            // Level 1: the local package
            expect(resolution.levels[1].length).toBe(1);
            expect(resolution.levels[1][0].name).toBe('apex-utils');
        });

        test('should include managed dependencies in transitive dependency resolution', () => {
            const mockProject: ProjectDefinition = {
                packageDirectories: [
                    { package: 'pkg-a', path: 'packages/pkg-a', default: false },
                    {
                        package: 'pkg-b',
                        path: 'packages/pkg-b',
                        default: false,
                        dependencies: [
                            { package: 'pkg-a' },
                            { package: 'Nebula Logger@4.16.0' }
                        ]
                    }
                ],
                packageAliases: {
                    'Nebula Logger@4.16.0': '04t5Y0000015pGyQAI'
                }
            };

            const graph = new ProjectGraph(mockProject);
            const deps = graph.getTransitiveDependencies('pkg-b');

            expect(deps.length).toBe(2);

            const managedDep = deps.find(d => d.package === 'Nebula Logger@4.16.0');
            expect(managedDep).toBeDefined();
            expect('packageVersionId' in managedDep!).toBe(true);
        });

        test('should handle multiple managed dependencies', () => {
            const mockProject: ProjectDefinition = {
                packageDirectories: [
                    {
                        package: 'my-app',
                        versionNumber: '1.0.0.NEXT',
                        path: 'src/app',
                        default: true,
                        dependencies: [
                            { package: 'Nebula Logger@4.16.0' },
                            { package: 'nCino@2.0.0' }
                        ]
                    }
                ],
                packageAliases: {
                    'my-app': '0Ho09000000oMKJCA2',
                    'Nebula Logger@4.16.0': '04t5Y0000015pGyQAI',
                    'nCino@2.0.0': '04t000000000XXXYYY'
                }
            };

            const graph = new ProjectGraph(mockProject);
            expect(graph.getAllNodes().length).toBe(3);

            const resolution = graph.resolveDependencies(['my-app']);
            expect(resolution.levels.length).toBe(2);

            // Both managed packages at level 0 (can install in parallel)
            expect(resolution.levels[0].length).toBe(2);
            expect(resolution.levels[0].every(n => n.isManaged)).toBe(true);
        });

        test('should handle mixed managed and project dependencies', () => {
            // my-app depends on core-lib (project) and Nebula Logger (managed)
            // core-lib has no dependencies
            const mockProject: ProjectDefinition = {
                packageDirectories: [
                    { package: 'core-lib', path: 'src/core', default: false },
                    {
                        package: 'my-app',
                        versionNumber: '1.0.0.NEXT',
                        path: 'src/app',
                        default: true,
                        dependencies: [
                            { package: 'core-lib', versionNumber: '1.0.0.NEXT' },
                            { package: 'Nebula Logger@4.16.0' }
                        ]
                    }
                ],
                packageAliases: {
                    'Nebula Logger@4.16.0': '04t5Y0000015pGyQAI'
                }
            };

            const graph = new ProjectGraph(mockProject);
            expect(graph.getAllNodes().length).toBe(3);

            const resolution = graph.resolveDependencies(['my-app']);
            expect(resolution.levels.length).toBe(2);

            // Level 0: core-lib and Nebula Logger (both are deps with no deps of their own)
            const level0Names = resolution.levels[0].map(n => n.name).sort();
            expect(level0Names).toEqual(['Nebula Logger@4.16.0', 'core-lib']);

            // Level 1: my-app
            expect(resolution.levels[1].map(n => n.name)).toEqual(['my-app']);
        });
    });
});
