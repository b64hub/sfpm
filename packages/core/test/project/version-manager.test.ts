
import { VersionManager, SinglePackageStrategy, AllPackagesStrategy, OrgDiffStrategy, OrgPackageVersionFetcher } from '../../src/project/version-manager.js';
import { ProjectDefinition } from '../../src/project/types.js';
import { ProjectFileReader } from '../../src/project/project-file-reader.js';

describe('VersionManager', () => {
    let mockProject: ProjectDefinition;

    beforeEach(() => {
        mockProject = {
            packageDirectories: [
                { package: 'pkg-a', path: 'packages/pkg-a', versionNumber: '1.0.0.NEXT', default: true },
                { package: 'pkg-b', path: 'packages/pkg-b', versionNumber: '1.0.0.LATEST', dependencies: [{ package: 'pkg-a', versionNumber: '1.0.0.NEXT' }] },
                { package: 'pkg-c', path: 'packages/pkg-c', versionNumber: '2.0.0.0', dependencies: [{ package: 'pkg-b', versionNumber: '1.0.0.LATEST' }] }
            ],
            packageAliases: {} // Add other required fields if any, checking types.ts
        } as ProjectDefinition;
    });

    test('should update single package (minor bump) and propagate to dependencies', async () => {
        const vm = new VersionManager({ projectConfig: mockProject });
        const result = await vm.checkUpdates(
            new SinglePackageStrategy('pkg-a'),
            'minor'
        );

        // pkg-a: 1.0.0.NEXT -> 1.1.0.NEXT
        const pkgA = result.packages.find(p => p.name === 'pkg-a');
        expect(pkgA).toBeDefined();
        expect(pkgA?.newVersion).toBe('1.1.0.NEXT');

        // pkg-b should assume new version of pkg-a
        // The dependencies array in result contains packages that had their dependencies updated
        const pkgB = result.dependencies?.find(p => p.name === 'pkg-b');
        expect(pkgB).toBeDefined();

        const depOnA = pkgB?.dependencies?.find(d => d.name === 'pkg-a');
        expect(depOnA?.newVersion).toBe('1.1.0');
    });

    test('should update all packages (patch bump)', async () => {
        const vm = new VersionManager({ projectConfig: mockProject });
        const result = await vm.checkUpdates(
            new AllPackagesStrategy(),
            'patch'
        );

        expect(result.packagesUpdated).toBe(3);

        const pkgA = result.packages.find(p => p.name === 'pkg-a');
        expect(pkgA?.newVersion).toBe('1.0.1.NEXT');
    });

    test('should use OrgDiffStrategy to detect updates', async () => {
        const mockFetcher: OrgPackageVersionFetcher = {
            getInstalledVersion: jest.fn(async (name: string) => {
                if (name === 'pkg-a') return '1.2.0.0';
                return null;
            })
        };

        const vm = new VersionManager({ projectConfig: mockProject });
        const result = await vm.checkUpdates(
            new OrgDiffStrategy(mockFetcher),
            'patch'
        );

        // Should update pkg-a
        const pkgA = result.packages.find(p => p.name === 'pkg-a');
        expect(pkgA).toBeDefined();
        // Base 1.2.0.0 + patch -> 1.2.1.NEXT
        expect(pkgA?.newVersion).toBe('1.2.1.NEXT');
    });

    test('should load and save project via ProjectFileReader', async () => {
        const mockReader: ProjectFileReader = {
            read: jest.fn(async () => mockProject),
            write: jest.fn(async () => { })
        };

        const vm = new VersionManager({ fileReader: mockReader });
        await vm.load();

        expect(mockReader.read).toHaveBeenCalled();

        await vm.checkUpdates(new SinglePackageStrategy('pkg-a'), 'minor');
        await vm.save();

        expect(mockReader.write).toHaveBeenCalled();
        const savedProject = (mockReader.write as jest.Mock).mock.calls[0][0] as ProjectDefinition;
        expect(savedProject.packageDirectories[0].versionNumber).toBe('1.1.0.NEXT');
    });
});
