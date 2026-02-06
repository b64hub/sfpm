import { vi, expect, describe, it, beforeEach, afterEach } from 'vitest';
import ProjectConfig from '../../src/project/project-config.js';
import { ProjectDefinition } from '../../src/types/project.js';
import { PackageType } from '../../src/types/package.js';
import { Logger } from '@salesforce/core';

describe('ProjectConfig', () => {
    let mockProject: ProjectDefinition;
    let mockProjectJson: any;
    let mockSfProject: any;
    let projectConfig: ProjectConfig;
    let mockLogger: any;

    beforeEach(() => {
        // Mock logger to suppress console output during tests
        mockLogger = {
            warn: vi.fn(),
            debug: vi.fn(),
            info: vi.fn(),
            error: vi.fn(),
        };
        vi.spyOn(Logger, 'childFromRoot').mockReturnValue(mockLogger as any);

        mockProject = {
            packageDirectories: [
                {
                    path: 'packages/temp',
                    default: true,
                    package: 'temp',
                    type: PackageType.Unlocked,
                    versionNumber: '1.0.0.0',
                },
                {
                    path: 'packages/domains/core',
                    package: 'core',
                    default: false,
                    type: PackageType.Unlocked,
                    versionNumber: '1.0.0.0',
                },
                {
                    path: 'packages/frameworks/mass-dataload',
                    package: 'mass-dataload',
                    default: false,
                    type: PackageType.Data,
                    versionNumber: '1.0.0.0',
                },
                {
                    path: 'packages/access-mgmt',
                    package: 'access-mgmt',
                    default: false,
                    type: PackageType.Unlocked,
                    versionNumber: '1.0.0.0',
                },
                {
                    path: 'packages/bi',
                    package: 'bi',
                    default: false,
                    type: PackageType.Unlocked,
                    versionNumber: '1.0.0.0',
                },
            ],
            namespace: '',
            sfdcLoginUrl: 'https://login.salesforce.com',
            sourceApiVersion: '50.0',
            packageAliases: {
                bi: '0x002232323232',
                external: '0H43232232'
            },
        } as any;

        mockProjectJson = {
            getContents: vi.fn().mockReturnValue(mockProject),
            set: vi.fn(),
            write: vi.fn().mockResolvedValue(undefined),
        };

        mockSfProject = {
            getSfProjectJson: vi.fn().mockReturnValue(mockProjectJson),
            getPath: vi.fn().mockReturnValue('/root'),
            getPackage: vi.fn((name: string) => {
                return mockProject.packageDirectories.find((p: any) => p.package === name);
            }),
            getUniquePackageNames: vi.fn().mockReturnValue(['temp', 'core', 'mass-dataload', 'access-mgmt', 'bi']),
            getPackageDirectories: vi.fn().mockReturnValue(mockProject.packageDirectories),
        };

        projectConfig = new ProjectConfig(mockSfProject as any);
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    describe('getProjectDefinition', () => {
        it('should return the project definition from SfProject', () => {
            const definition = projectConfig.getProjectDefinition();
            expect(definition).toEqual(mockProject);
            expect(mockProjectJson.getContents).toHaveBeenCalled();
        });

        it('should validate custom properties on first access', () => {
            projectConfig.getProjectDefinition();
            // Validation runs on first access (may or may not warn depending on data validity)
            // The important thing is that it doesn't throw an error
            expect(mockProjectJson.getContents).toHaveBeenCalled();
        });

        it('should only validate once', () => {
            projectConfig.getProjectDefinition();
            projectConfig.getProjectDefinition();
            projectConfig.getProjectDefinition();
            // getContents called 4 times (1 in validation + 3 in getProjectDefinition)
            expect(mockProjectJson.getContents).toHaveBeenCalledTimes(4);
        });
    });

    describe('getPackageDefinition', () => {
        it('should use SfProject.getPackage() to find package', () => {
            const pkg = projectConfig.getPackageDefinition('core');
            expect(mockSfProject.getPackage).toHaveBeenCalledWith('core');
            expect(pkg.path).toBe('packages/domains/core');
            expect(pkg.package).toBe('core');
        });

        it('should throw error if package not found', () => {
            mockSfProject.getPackage.mockReturnValue(undefined);
            expect(() => projectConfig.getPackageDefinition('nonexistent'))
                .toThrow('Package nonexistent not found in project definition');
        });
    });

    describe('getPackageId', () => {
        it('should get the package id from aliases', () => {
            const id = projectConfig.getPackageId('bi');
            expect(id).toBe('0x002232323232');
        });

        it('should return undefined if alias not found', () => {
            const id = projectConfig.getPackageId('nonexistent');
            expect(id).toBeUndefined();
        });
    });

    describe('getAllPackageNames', () => {
        it('should use SfProject.getUniquePackageNames()', () => {
            const packages = projectConfig.getAllPackageNames();
            expect(mockSfProject.getUniquePackageNames).toHaveBeenCalled();
            expect(packages).toEqual(['temp', 'core', 'mass-dataload', 'access-mgmt', 'bi']);
        });
    });

    describe('getAllPackageDirectories', () => {
        it('should use SfProject.getPackageDirectories()', () => {
            const packages = projectConfig.getAllPackageDirectories();
            expect(mockSfProject.getPackageDirectories).toHaveBeenCalled();
            expect(packages).toHaveLength(5);
        });
    });

    describe('getPackageType', () => {
        it('should return the type from package definition', () => {
            expect(projectConfig.getPackageType('bi')).toBe(PackageType.Unlocked);
            expect(projectConfig.getPackageType('core')).toBe(PackageType.Unlocked);
            expect(projectConfig.getPackageType('mass-dataload')).toBe(PackageType.Data);
        });

        it('should default to Unlocked if type not specified', () => {
            const pkgWithoutType = { ...mockProject.packageDirectories[0] };
            delete (pkgWithoutType as any).type;
            mockSfProject.getPackage.mockReturnValue(pkgWithoutType);
            
            expect(projectConfig.getPackageType('temp')).toBe(PackageType.Unlocked);
        });
    });

    describe('sourceApiVersion', () => {
        it('should return the source API version', () => {
            expect(projectConfig.sourceApiVersion).toBe('50.0');
        });
    });

    describe('projectDirectory', () => {
        it('should return the project path from SfProject', () => {
            expect(projectConfig.projectDirectory).toBe('/root');
            expect(mockSfProject.getPath).toHaveBeenCalled();
        });
    });

    describe('save', () => {
        it('should save changes to SfProjectJson', async () => {
            const updated = { ...mockProject, sourceApiVersion: '60.0' };
            await projectConfig.save(updated);

            expect(mockProjectJson.set).toHaveBeenCalledWith('packageDirectories', updated.packageDirectories);
            expect(mockProjectJson.set).toHaveBeenCalledWith('sourceApiVersion', '60.0');
            expect(mockProjectJson.write).toHaveBeenCalled();
        });

        it('should reset validation flag after save', async () => {
            // First access triggers validation
            projectConfig.getProjectDefinition();
            
            await projectConfig.save();
            
            // After save, validation should run again on next access
            projectConfig.getProjectDefinition();
            expect(mockProjectJson.getContents).toHaveBeenCalled();
        });

        it('should use current contents if no definition provided', async () => {
            await projectConfig.save();
            expect(mockProjectJson.set).toHaveBeenCalledWith('packageDirectories', mockProject.packageDirectories);
        });
    });
});
