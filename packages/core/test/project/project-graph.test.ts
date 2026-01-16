
import { describe, test, expect } from '@jest/globals';
import { ProjectGraph } from '../../src/project/project-graph.js';
import { ProjectDefinition } from '../../src/project/types.js';

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
});
