import { describe, test, expect, beforeEach, vi, afterEach } from 'vitest';
import ProjectService from '../../src/project/project-service.js';
import { SfProject, Logger } from '@salesforce/core';
import { PackageType } from '../../src/types/package.js';

describe('ProjectService', () => {
    let mockLogger: any;

    beforeEach(() => {
        ProjectService.resetInstance();
        
        // Mock logger to suppress console output
        mockLogger = {
            warn: vi.fn(),
            debug: vi.fn(),
            info: vi.fn(),
            error: vi.fn(),
        };
        vi.spyOn(Logger, 'childFromRoot').mockReturnValue(mockLogger as any);
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    describe('Singleton Pattern', () => {
        test('should maintain a singleton instance', () => {
            const instance1 = ProjectService.getInstance();
            const instance2 = ProjectService.getInstance();
            expect(instance1).toBe(instance2);
        });

        test('should reset the singleton instance', () => {
            const instance1 = ProjectService.getInstance();
            ProjectService.resetInstance();
            const instance2 = ProjectService.getInstance();
            expect(instance1).not.toBe(instance2);
        });
    });

    describe('initialize', () => {
        test('should initialize with directory path', async () => {
            const mockDefinition = {
                packageDirectories: [
                    { package: 'pkg-a', path: 'packages/pkg-a', versionNumber: '1.0.0.NEXT' }
                ],
                sourceApiVersion: '60.0'
            };

            const mockSfProject = {
                getPath: () => '/mock/path',
                getSfProjectJson: () => ({
                    getContents: () => mockDefinition,
                    write: vi.fn(),
                    set: vi.fn()
                }),
                getPackage: (name: string) => mockDefinition.packageDirectories.find((p: any) => p.package === name),
                getUniquePackageNames: () => ['pkg-a'],
                getPackageDirectories: () => mockDefinition.packageDirectories,
            };

            vi.spyOn(SfProject, 'resolve').mockResolvedValue(mockSfProject as any);

            const service = new ProjectService('/mock/path');
            await service.initialize();

            expect(SfProject.resolve).toHaveBeenCalledWith('/mock/path');
            expect(service.getProjectConfig()).toBeDefined();
        });
    });

    describe('Static Helpers', () => {
        test('getProjectDefinition should return project definition', async () => {
            const mockDefinition = {
                packageDirectories: [
                    { package: 'pkg-a', path: 'packages/pkg-a', versionNumber: '1.0.0.NEXT' }
                ],
                sourceApiVersion: '60.0',
                packageAliases: {}
            };

            const mockSfProject = {
                getPath: () => '/mock/path',
                getSfProjectJson: () => ({
                    getContents: () => mockDefinition,
                }),
                getPackage: (name: string) => mockDefinition.packageDirectories.find((p: any) => p.package === name),
                getUniquePackageNames: () => ['pkg-a'],
                getPackageDirectories: () => mockDefinition.packageDirectories,
            };

            vi.spyOn(SfProject, 'resolve').mockResolvedValue(mockSfProject as any);

            const definition = await ProjectService.getProjectDefinition('/mock/path');
            expect(definition).toEqual(mockDefinition);
        });

        test('getPackageDefinition should return specific package', async () => {
            const mockDefinition = {
                packageDirectories: [
                    { package: 'pkg-a', path: 'packages/pkg-a', versionNumber: '1.0.0.NEXT', type: PackageType.Unlocked }
                ],
                sourceApiVersion: '60.0'
            };

            const mockSfProject = {
                getPath: () => '/mock/path',
                getSfProjectJson: () => ({
                    getContents: () => mockDefinition,
                }),
                getPackage: (name: string) => mockDefinition.packageDirectories.find((p: any) => p.package === name),
                getUniquePackageNames: () => ['pkg-a'],
                getPackageDirectories: () => mockDefinition.packageDirectories,
            };

            vi.spyOn(SfProject, 'resolve').mockResolvedValue(mockSfProject as any);

            const pkg = await ProjectService.getPackageDefinition('pkg-a');
            expect(pkg.package).toBe('pkg-a');
            expect(pkg.path).toBe('packages/pkg-a');
        });

        test('getPackageType should return package type', async () => {
            const mockDefinition = {
                packageDirectories: [
                    { package: 'pkg-a', path: 'packages/pkg-a', versionNumber: '1.0.0.NEXT', type: PackageType.Data }
                ],
                sourceApiVersion: '60.0'
            };

            const mockSfProject = {
                getPath: () => '/mock/path',
                getSfProjectJson: () => ({
                    getContents: () => mockDefinition,
                }),
                getPackage: (name: string) => mockDefinition.packageDirectories.find((p: any) => p.package === name),
                getUniquePackageNames: () => ['pkg-a'],
                getPackageDirectories: () => mockDefinition.packageDirectories,
            };

            vi.spyOn(SfProject, 'resolve').mockResolvedValue(mockSfProject as any);

            const type = await ProjectService.getPackageType('pkg-a');
            expect(type).toBe(PackageType.Data);
        });

        test('getPackageDependencies should resolve transitive dependencies', async () => {
            const mockDefinition = {
                packageDirectories: [
                    { package: 'pkg-a', path: 'packages/pkg-a', versionNumber: '1.0.0.NEXT', dependencies: [{ package: 'pkg-b', versionNumber: '1.0.0.NEXT' }] },
                    { package: 'pkg-b', path: 'packages/pkg-b', versionNumber: '1.0.0.NEXT', dependencies: [{ package: 'pkg-c', versionNumber: '1.0.0.NEXT' }] },
                    { package: 'pkg-c', path: 'packages/pkg-c', versionNumber: '1.0.0.NEXT', dependencies: [] }
                ],
                sourceApiVersion: '60.0'
            };

            const mockSfProject = {
                getPath: () => '/mock/path',
                getSfProjectJson: () => ({
                    getContents: () => mockDefinition,
                    write: vi.fn(),
                    set: vi.fn()
                }),
                getPackage: (name: string) => mockDefinition.packageDirectories.find((p: any) => p.package === name),
                getUniquePackageNames: () => ['pkg-a', 'pkg-b', 'pkg-c'],
                getPackageDirectories: () => mockDefinition.packageDirectories,
            };

            vi.spyOn(SfProject, 'resolve').mockResolvedValue(mockSfProject as any);

            const deps = await ProjectService.getPackageDependencies('pkg-a');

            // Should return pkg-c and pkg-b (topological order: dependencies before dependents)
            expect(deps).toHaveLength(2);
            expect(deps[0].package).toBe('pkg-c');
            expect(deps[1].package).toBe('pkg-b');
        });
    });
});
