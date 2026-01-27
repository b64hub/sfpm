import { vi, expect, describe, it, beforeEach } from 'vitest';
import ProjectConfig from '../../src/project/project-config.js';
import { ProjectDefinition } from '../../src/types/project.js';
import { PackageType } from '../../src/types/package.js';

describe('ProjectConfig', () => {
    let mockProject: ProjectDefinition;
    let mockProjectJson: any;
    let mockSfProject: any;
    let projectConfig: ProjectConfig;

    beforeEach(() => {
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
        };

        projectConfig = new ProjectConfig(mockSfProject as any);
        (projectConfig as any).definition = mockProject; // bypass load() for simple tests
    });

    it('should get the package id of an unlocked package', async () => {
        const id = await projectConfig.getPackageId('bi');
        expect(id).toBe('0x002232323232');
    });

    it('should return undefined if the package id is missing in aliases', () => {
        const id = projectConfig.getPackageId('nonexistent');
        expect(id).toBeUndefined();
    });

    it('should fetch all internal packages', async () => {
        const packages = projectConfig.getAllPackageNames();
        expect(packages).toEqual(['temp', 'core', 'mass-dataload', 'access-mgmt', 'bi']);
    });

    it('should get the type of a package', async () => {
        expect(await projectConfig.getPackageType('bi')).toBe(PackageType.Unlocked);
        expect(await projectConfig.getPackageType('core')).toBe(PackageType.Unlocked);
        expect(await projectConfig.getPackageType('mass-dataload')).toBe(PackageType.Data);
    });

    it('should get the package descriptor of a provided package', async () => {
        const descriptor = projectConfig.getPackageDefinition('core');
        expect(descriptor.path).toBe('packages/domains/core');
        expect(descriptor.package).toBe('core');
    });

    it('should throw if package descriptor is not found', async () => {
        expect(() => projectConfig.getPackageDefinition('nonexistent'))
            .toThrow("Package nonexistent not found in project definition");
    });

});
