import { jest, expect } from '@jest/globals';
import ProjectConfig from '../../src/project/project-config.js';
import { ProjectDefinition, ProjectFileReader } from '../../src/project/types.js';
import { PackageType } from '../../src/types/package.js';

describe('ProjectConfig', () => {
    let mockProject: ProjectDefinition;
    let mockFileReader: jest.Mocked<ProjectFileReader>;
    let projectConfig: ProjectConfig;

    beforeEach(() => {
        mockProject = {
            packageDirectories: [
                {
                    path: 'packages/temp',
                    default: true,
                    package: 'temp',
                    versionNumber: '1.0.0.0',
                    ignoreOnStages: ['prepare', 'validate', 'build'],
                },
                {
                    path: 'packages/domains/core',
                    package: 'core',
                    default: false,
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
                    versionNumber: '1.0.0.0',
                },
                {
                    path: 'packages/bi',
                    package: 'bi',
                    default: false,
                    versionNumber: '1.0.0.0',
                    ignoreOnStages: ['prepare', 'validate'],
                },
            ],
            namespace: '',
            sfdcLoginUrl: 'https://login.salesforce.com',
            sourceApiVersion: '50.0',
            packageAliases: {
                bi: '0x002232323232',
                external: '0H43232232'
            },
        };

        mockFileReader = {
            read: jest.fn<() => Promise<ProjectDefinition>>().mockResolvedValue(mockProject),
            write: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
        } as any;

        projectConfig = new ProjectConfig(mockFileReader);
    });

    it('should get the package id of an unlocked package', async () => {
        const id = await projectConfig.getPackageId('bi');
        expect(id).toBe('0x002232323232');
    });

    it('should throw an error if the package id is missing in aliases', async () => {
        await expect(projectConfig.getPackageId('nonexistent'))
            .rejects.toThrow("No Package Id found for 'nonexistent'");
    });

    it('should fetch all internal packages', async () => {
        const packages = await projectConfig.getAllPackages();
        expect(packages).toEqual(['temp', 'core', 'mass-dataload', 'access-mgmt', 'bi']);
    });

    it('should get the type of a package', async () => {
        expect(await projectConfig.getPackageType('bi')).toBe(PackageType.Unlocked);
        expect(await projectConfig.getPackageType('core')).toBe(PackageType.Source);
        expect(await projectConfig.getPackageType('mass-dataload')).toBe(PackageType.Data);
    });

    it('should get the package descriptor of a provided package', async () => {
        const descriptor = await projectConfig.getPackageDescriptor('core');
        expect(descriptor.path).toBe('packages/domains/core');
        expect(descriptor.package).toBe('core');
    });

    it('should throw if package descriptor is not found', async () => {
        await expect(projectConfig.getPackageDescriptor('nonexistent'))
            .rejects.toThrow("Package 'nonexistent' does not exist");
    });

    it('should get the default package descriptor', async () => {
        const descriptor = await projectConfig.getDefaultPackageDescriptor();
        expect(descriptor.package).toBe('temp');
        expect(descriptor.default).toBe(true);
    });

    it('should get external packages', async () => {
        const external = await projectConfig.getExternalPackages();
        expect(external).toEqual([
            { alias: 'external', packageId: '0H43232232' }
        ]);
        // 'bi' is in packageDirectories, so it's not "external" in this context
    });

    it('should get dependency map', async () => {
        mockProject.packageDirectories[1].dependencies = [
            { package: 'temp', versionNumber: '1.0.0.0' }
        ];

        const map = await projectConfig.getDependencyMap();
        expect(map.get('core')).toEqual([
            { package: 'temp', versionNumber: '1.0.0.0' }
        ]);
    });

    it('should filter packages', async () => {
        const filtered = await projectConfig.filterPackages(['core', 'bi']);
        expect(filtered.packageDirectories.length).toBe(2);
        expect(filtered.packageDirectories[0].package).toBe('core');
        expect(filtered.packageDirectories[0].default).toBe(true); // first package becomes default
    });
});
