import { describe, test, expect, vi, beforeEach } from 'vitest';
import { VersionManager, SinglePackageStrategy, AllPackagesStrategy, OrgDiffStrategy } from '../../src/project/version-manager.js';
import { ProjectDefinition } from '../../src/types/project.js';
import { OrgPackageVersionFetcher } from '../../src/types/org.js';
import ProjectConfig from '../../src/project/project-config.js';

describe('VersionManager', () => {
    let mockProject: ProjectDefinition;
    let mockProjectConfig: any;

    beforeEach(() => {
        mockProject = {
            packageDirectories: [
                { package: 'pkg-a', path: 'packages/pkg-a', versionNumber: '1.0.0.NEXT', default: true },
                { package: 'pkg-b', path: 'packages/pkg-b', versionNumber: '1.0.0.NEXT', dependencies: [{ package: 'pkg-a', versionNumber: '1.0.0.LATEST' }] },
                { package: 'pkg-c', path: 'packages/pkg-c', versionNumber: '2.0.0.0', dependencies: [{ package: 'pkg-b', versionNumber: '1.0.0.LATEST' }] }
            ],
            packageAliases: {}
        } as any;

        mockProjectConfig = {
            getProjectDefinition: vi.fn().mockReturnValue(mockProject),
            save: vi.fn().mockResolvedValue(undefined),
        };
    });

    test('should update single package (minor bump) and propagate to dependencies', async () => {
        const vm = new VersionManager({ projectConfig: mockProjectConfig as any });
        const result = await vm.bump(
            'minor',
            { strategy: new SinglePackageStrategy('pkg-a') }
        );

        // pkg-a: 1.0.0.NEXT -> 1.1.0.NEXT
        const pkgA = result.packages.find(p => p.name === 'pkg-a');
        expect(pkgA).toBeDefined();
        expect(pkgA?.newVersion).toBe('1.1.0-NEXT');

        // pkg-b should assume new version of pkg-a
        const pkgB = result.dependencies?.find(p => p.name === 'pkg-b');
        expect(pkgB).toBeDefined();

        const depOnA = pkgB?.dependencies?.find(d => d.name === 'pkg-a');
        expect(depOnA?.newVersion).toBe('1.1.0');
    });

    test('should update all packages (patch bump)', async () => {
        const vm = new VersionManager({ projectConfig: mockProjectConfig as any });
        const result = await vm.bump(
            'patch',
            { strategy: new AllPackagesStrategy() }
        );

        expect(result.packagesUpdated).toBe(3);

        const pkgA = result.packages.find(p => p.name === 'pkg-a');
        expect(pkgA?.newVersion).toBe('1.0.1-NEXT');
    });

    test('should use OrgDiffStrategy to detect updates', async () => {
        const mockFetcher: OrgPackageVersionFetcher = {
            getInstalledVersion: vi.fn(async (name: string) => {
                if (name === 'pkg-a') return '1.2.0.0';
                return null;
            })
        };

        const vm = new VersionManager({ projectConfig: mockProjectConfig as any });
        const result = await vm.bump(
            'patch',
            { strategy: new OrgDiffStrategy(mockFetcher) }
        );

        // Should update pkg-a
        const pkgA = result.packages.find(p => p.name === 'pkg-a');
        expect(pkgA).toBeDefined();
        // Base 1.2.0.0 + patch -> 1.2.1.NEXT
        expect(pkgA?.newVersion).toBe('1.2.1-NEXT');
    });

    test('should load and save project', async () => {
        const vm = new VersionManager({ projectConfig: mockProjectConfig as any });
        await vm.load();

        // ProjectConfig.load() was removed - validation happens lazily now
        expect(mockProjectConfig.getProjectDefinition).toHaveBeenCalled();

        await vm.bump('minor', { strategy: new SinglePackageStrategy('pkg-a') });
        await vm.save();

        expect(mockProjectConfig.save).toHaveBeenCalled();
    });
});

