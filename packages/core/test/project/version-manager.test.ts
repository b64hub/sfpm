import { describe, test, expect, vi, beforeEach } from 'vitest';
import { VersionManager, SinglePackageStrategy, AllPackagesStrategy, OrgDiffStrategy, GitDiffStrategy } from '../../src/project/version-manager.js';
import { GitService } from '../../src/git/git-service.js';
import type { ProjectDefinitionProvider } from '../../src/project/providers/project-definition-provider.js';
import { ProjectDefinition } from '../../src/types/project.js';
import { OrgPackageVersionFetcher } from '../../src/types/org.js';
import { ProjectGraph } from '../../src/project/project-graph.js';

/** Wraps a ProjectDefinition in a minimal ProjectDefinitionProvider for testing. */
function asProvider(definition: ProjectDefinition): ProjectDefinitionProvider {
    return { getProjectDefinition: () => definition } as unknown as ProjectDefinitionProvider;
}

describe('VersionManager', () => {
    let mockProject: ProjectDefinition;

    beforeEach(() => {
        mockProject = {
            packageDirectories: [
                { package: 'pkg-a', path: 'packages/pkg-a', versionNumber: '1.0.0.NEXT', default: true },
                { package: 'pkg-b', path: 'packages/pkg-b', versionNumber: '1.0.0.NEXT', dependencies: [{ package: 'pkg-a', versionNumber: '1.0.0.LATEST' }] },
                { package: 'pkg-c', path: 'packages/pkg-c', versionNumber: '2.0.0.0', dependencies: [{ package: 'pkg-b', versionNumber: '1.0.0.LATEST' }] }
            ],
            packageAliases: {}
        } as any;
    });

    test('should update single package (minor bump) and propagate to dependencies', async () => {
        const graph = new ProjectGraph(asProvider(mockProject));
        const vm = VersionManager.create(graph, mockProject);
        const result = await vm.bump(
            'minor',
            { strategy: new SinglePackageStrategy('pkg-a') }
        );

        // pkg-a: 1.0.0.NEXT -> 1.1.0.NEXT
        const pkgA = result.packages.find(p => p.name === 'pkg-a');
        expect(pkgA).toBeDefined();
        expect(pkgA?.newVersion).toBe('1.1.0.NEXT');

        // pkg-b should assume new version of pkg-a
        const pkgB = result.dependencies?.find(p => p.name === 'pkg-b');
        expect(pkgB).toBeDefined();

        const depOnA = pkgB?.dependencies?.find(d => d.name === 'pkg-a');
        expect(depOnA?.newVersion).toBe('1.1.0.LATEST');
    });

    test('should update all packages (patch bump)', async () => {
        const graph = new ProjectGraph(asProvider(mockProject));
        const vm = VersionManager.create(graph, mockProject);
        const result = await vm.bump(
            'patch',
            { strategy: new AllPackagesStrategy() }
        );

        expect(result.packagesUpdated).toBe(3);

        const pkgA = result.packages.find(p => p.name === 'pkg-a');
        expect(pkgA?.newVersion).toBe('1.0.1.NEXT');
    });

    test('should use OrgDiffStrategy to detect updates', async () => {
        const mockFetcher: OrgPackageVersionFetcher = {
            getInstalledVersion: vi.fn(async (name: string) => {
                if (name === 'pkg-a') return '1.2.0.0';
                return null;
            })
        };

        const graph = new ProjectGraph(asProvider(mockProject));
        const vm = VersionManager.create(graph, mockProject);
        const result = await vm.bump(
            'patch',
            { strategy: new OrgDiffStrategy(mockFetcher) }
        );

        // Should update pkg-a
        const pkgA = result.packages.find(p => p.name === 'pkg-a');
        expect(pkgA).toBeDefined();
        // Base 1.2.0.0 + patch -> 1.2.1.NEXT
        expect(pkgA?.newVersion).toBe('1.2.1.NEXT');
    });

    test('should return updated definition after bump', async () => {
        const graph = new ProjectGraph(asProvider(mockProject));
        const vm = VersionManager.create(graph, mockProject);

        await vm.bump('minor', { strategy: new SinglePackageStrategy('pkg-a') });
        const updatedDefinition = vm.getUpdatedDefinition();

        expect(updatedDefinition).toBeDefined();
        expect(updatedDefinition.packageDirectories).toBeDefined();
    });

    test('should write updated dependency versions to definition', async () => {
        const graph = new ProjectGraph(asProvider(mockProject));
        const vm = VersionManager.create(graph, mockProject);

        // Bump only pkg-a; pkg-b depends on pkg-a so its dependency ref should update
        await vm.bump('minor', { strategy: new SinglePackageStrategy('pkg-a') });
        const updatedDefinition = vm.getUpdatedDefinition();

        const pkgB = (updatedDefinition.packageDirectories as any[]).find(p => p.package === 'pkg-b');
        expect(pkgB).toBeDefined();
        const depOnA = pkgB.dependencies?.find((d: any) => d.package === 'pkg-a');
        expect(depOnA).toBeDefined();
        expect(depOnA.versionNumber).toBe('1.1.0.LATEST');
    });

    describe('GitDiffStrategy', () => {
        function createMockGitService(changedPaths: string[]): GitService {
            return {
                getChangedPackagePaths: vi.fn(async (_baseRef: string, packagePaths: string[]) => {
                    return packagePaths.filter(pkgPath => changedPaths.some(cp => cp === pkgPath));
                }),
            } as unknown as GitService;
        }

        test('should identify changed packages from git diff', async () => {
            const gitService = createMockGitService(['packages/pkg-a']);

            const graph = new ProjectGraph(asProvider(mockProject));
            const vm = VersionManager.create(graph, mockProject);
            const result = await vm.bump('patch', {
                strategy: new GitDiffStrategy('main', gitService),
            });

            expect(result.packagesUpdated).toBe(1);
            expect(result.packages[0].name).toBe('pkg-a');
            expect(result.packages[0].newVersion).toBe('1.0.1.NEXT');
            expect(gitService.getChangedPackagePaths).toHaveBeenCalledWith(
                'main',
                expect.arrayContaining(['packages/pkg-a', 'packages/pkg-b', 'packages/pkg-c']),
            );
        });

        test('should return no packages when no files changed', async () => {
            const gitService = createMockGitService([]);

            const graph = new ProjectGraph(asProvider(mockProject));
            const vm = VersionManager.create(graph, mockProject);
            const result = await vm.bump('patch', {
                strategy: new GitDiffStrategy('main', gitService),
            });

            expect(result.packagesUpdated).toBe(0);
        });

        test('should identify multiple changed packages', async () => {
            const gitService = createMockGitService(['packages/pkg-a', 'packages/pkg-c']);

            const graph = new ProjectGraph(asProvider(mockProject));
            const vm = VersionManager.create(graph, mockProject);
            const result = await vm.bump('minor', {
                strategy: new GitDiffStrategy('main', gitService),
            });

            expect(result.packagesUpdated).toBe(2);
            const names = result.packages.map(p => p.name).sort();
            expect(names).toEqual(['pkg-a', 'pkg-c']);
        });
    });

    describe('toSalesforceVersion', () => {
        test('converts npm format to Salesforce format', () => {
            expect(VersionManager.toSalesforceVersion('0.1.0-NEXT')).toBe('0.1.0.NEXT');
            expect(VersionManager.toSalesforceVersion('1.2.3-7')).toBe('1.2.3.7');
            expect(VersionManager.toSalesforceVersion('1.0.0-LATEST')).toBe('1.0.0.LATEST');
        });

        test('returns Salesforce format as-is', () => {
            expect(VersionManager.toSalesforceVersion('0.1.0.NEXT')).toBe('0.1.0.NEXT');
            expect(VersionManager.toSalesforceVersion('1.2.3.42')).toBe('1.2.3.42');
            expect(VersionManager.toSalesforceVersion('1.0.0.LATEST')).toBe('1.0.0.LATEST');
        });

        test('appends .NEXT to plain 3-part semver', () => {
            expect(VersionManager.toSalesforceVersion('1.0.0')).toBe('1.0.0.NEXT');
        });

        test('returns default for empty input', () => {
            expect(VersionManager.toSalesforceVersion('')).toBe('0.0.0.NEXT');
        });

        test('throws on unsupported format', () => {
            expect(() => VersionManager.toSalesforceVersion('not-a-version')).toThrow('Invalid version format');
        });
    });
});
