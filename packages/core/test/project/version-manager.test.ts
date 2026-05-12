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
            packages: [
                { name: 'pkg-a', path: 'packages/pkg-a', version: '1.0.0', type: 'unlocked' },
                { name: 'pkg-b', path: 'packages/pkg-b', version: '1.0.0', type: 'unlocked', dependencies: { 'pkg-a': '1.0.0' } },
                { name: 'pkg-c', path: 'packages/pkg-c', version: '2.0.0', type: 'source', dependencies: { 'pkg-b': '1.0.0' } }
            ],
        };
    });

    test('should update single package (minor bump) and propagate to dependencies', async () => {
        const graph = new ProjectGraph(asProvider(mockProject));
        const vm = VersionManager.create(graph, mockProject);
        const result = await vm.bump(
            'minor',
            { strategy: new SinglePackageStrategy('pkg-a') }
        );

        // pkg-a: 1.0.0 -> 1.1.0
        const pkgA = result.packages.find(p => p.name === 'pkg-a');
        expect(pkgA).toBeDefined();
        expect(pkgA?.newVersion).toBe('1.1.0');

        // pkg-b should assume new version of pkg-a
        const pkgB = result.dependencies?.find(p => p.name === 'pkg-b');
        expect(pkgB).toBeDefined();

        const depOnA = pkgB?.dependencies?.find(d => d.name === 'pkg-a');
        expect(depOnA?.newVersion).toBe('1.1.0');
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
        expect(pkgA?.newVersion).toBe('1.0.1');
    });

    test('should use OrgDiffStrategy to detect updates', async () => {
        const mockFetcher: OrgPackageVersionFetcher = {
            getInstalledVersion: vi.fn(async (name: string) => {
                if (name === 'pkg-a') return '1.2.0';
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
        // Base 1.2.0 + patch -> 1.2.1
        expect(pkgA?.newVersion).toBe('1.2.1');
    });

    test('should return updated definition after bump', async () => {
        const graph = new ProjectGraph(asProvider(mockProject));
        const vm = VersionManager.create(graph, mockProject);

        await vm.bump('minor', { strategy: new SinglePackageStrategy('pkg-a') });
        const updatedDefinition = vm.getUpdatedDefinition();

        expect(updatedDefinition).toBeDefined();
        expect(updatedDefinition.packages).toBeDefined();
    });

    test('should write updated dependency versions to definition', async () => {
        const graph = new ProjectGraph(asProvider(mockProject));
        const vm = VersionManager.create(graph, mockProject);

        // Bump only pkg-a; pkg-b depends on pkg-a so its dependency ref should update
        await vm.bump('minor', { strategy: new SinglePackageStrategy('pkg-a') });
        const updatedDefinition = vm.getUpdatedDefinition();

        const pkgB = updatedDefinition.packages.find(p => p.name === 'pkg-b');
        expect(pkgB).toBeDefined();
        expect(pkgB?.dependencies?.['pkg-a']).toBe('1.1.0');
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
            expect(result.packages[0].newVersion).toBe('1.0.1');
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
});
