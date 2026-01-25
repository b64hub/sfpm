import { describe, test, expect, beforeEach, vi } from 'vitest';
import ProjectService from '../../src/project/project-service.js';
import { SfProject } from '@salesforce/core';

describe('ProjectService', () => {
    beforeEach(() => {
        ProjectService.resetInstance();
        vi.restoreAllMocks();
    });

    test('should maintain a singleton instance', () => {
        const instance1 = ProjectService.getInstance();
        const instance2 = ProjectService.getInstance();
        expect(instance1).toBe(instance2);
    });

    test('getPackageDependencies should resolve transitive dependencies', async () => {
        // Mock project definition with dependencies
        const mockDefinition = {
            packageDirectories: [
                { package: 'pkg-a', path: 'packages/pkg-a', versionNumber: '1.0.0.NEXT', dependencies: [{ package: 'pkg-b', versionNumber: '1.0.0.NEXT' }] },
                { package: 'pkg-b', path: 'packages/pkg-b', versionNumber: '1.0.0.NEXT', dependencies: [{ package: 'pkg-c', versionNumber: '1.0.0.NEXT' }] },
                { package: 'pkg-c', path: 'packages/pkg-c', versionNumber: '1.0.0.NEXT' }
            ],
            sourceApiVersion: '60.0'
        };

        const mockSfProject = {
            getPath: () => '/mock/path',
            getSfProjectJson: () => ({
                getContents: () => mockDefinition,
                write: vi.fn(),
                set: vi.fn()
            })
        };

        vi.spyOn(SfProject, 'resolve').mockResolvedValue(mockSfProject as any);

        const deps = await ProjectService.getPackageDependencies('pkg-a');

        // Should return pkg-c and pkg-b (topological order: dependencies before dependents)
        expect(deps).toHaveLength(2);
        expect(deps[0].package).toBe('pkg-c');
        expect(deps[1].package).toBe('pkg-b');
    });

    test('getPackageDefinition should return correct package', async () => {
        const mockDefinition = {
            packageDirectories: [
                { package: 'pkg-a', path: 'packages/pkg-a', versionNumber: '1.0.0.NEXT' }
            ]
        };

        const mockSfProject = {
            getPath: () => '/mock/path',
            getSfProjectJson: () => ({
                getContents: () => mockDefinition
            })
        };

        vi.spyOn(SfProject, 'resolve').mockResolvedValue(mockSfProject as any);

        const pkg = await ProjectService.getPackageDefinition('pkg-a');
        expect(pkg.package).toBe('pkg-a');
        expect(pkg.path).toBe('packages/pkg-a');
    });
});
