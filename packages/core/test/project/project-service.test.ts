
import { describe, test, expect, jest } from '@jest/globals';
import ProjectService from '../../src/project/project-service.js';
import { ProjectDefinition } from '../../src/project/types.js';

describe('ProjectService', () => {
    test('should expose version manager and project graph', async () => {
        const mockProject: ProjectDefinition = {
            packageDirectories: [
                { package: 'pkg-a', path: 'packages/pkg-a', default: true }
            ]
        };

        const service = new ProjectService({
            projectConfig: mockProject
        });

        const vm = service.getVersionManager();
        expect(vm).toBeDefined();

        const graph = service.getProjectGraph();
        expect(graph).toBeDefined();
        expect(graph?.getNode('pkg-a')).toBeDefined();
    });
});
