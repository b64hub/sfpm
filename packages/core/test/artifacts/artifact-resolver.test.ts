import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs-extra';
import { ArtifactResolver } from '../../src/artifacts/artifact-resolver.js';
import { ArtifactRepository } from '../../src/artifacts/artifact-repository.js';
import { ArtifactError } from '../../src/types/errors.js';

// Mock external dependencies
vi.mock('fs-extra');
vi.mock('child_process');

describe('ArtifactResolver', () => {
    let resolver: ArtifactResolver;
    const packageWorkspacePath = '/test/project/packages/my-pkg';

    const mockLogger = {
        warn: vi.fn(),
        error: vi.fn(),
        info: vi.fn(),
        debug: vi.fn(),
        trace: vi.fn(),
    };

    // Factory for creating mock registry clients
    const createMockRegistryClient = (versions: string[] = ['1.0.0-1']) => ({
        getVersions: vi.fn().mockResolvedValue(versions),
        downloadPackage: vi.fn().mockResolvedValue({ 
            tarballPath: '/tmp/package.tgz',
            version: versions[0] || '1.0.0-1'
        }),
        getPackageInfo: vi.fn().mockResolvedValue({
            name: '@testorg/test-package',
            versions: versions.reduce((acc, v) => ({ ...acc, [v]: {} }), {}),
        }),
        packageExists: vi.fn().mockResolvedValue(true),
        getRegistryUrl: vi.fn().mockReturnValue('https://registry.npmjs.org'),
    });

    // Mock dist/package.json content
    const createMockDistPackageJson = (overrides?: Record<string, any>) => ({
        name: '@testorg/test-package',
        version: '1.0.0-1',
        sfpm: {
            packageType: 'unlocked',
            sourceHash: 'abc123',
            packageVersionId: '04t1234567890',
        },
        ...overrides,
    });

    // Factory for creating a resolver with mock dependencies
    const createResolverWithMocks = (mockRegistryClient?: ReturnType<typeof createMockRegistryClient>) => {
        const repository = new ArtifactRepository(packageWorkspacePath, mockLogger);
        const registryClient = mockRegistryClient || createMockRegistryClient();
        return new ArtifactResolver(repository, registryClient, mockLogger);
    };

    // Factory for creating a local-only resolver (no registry client)
    const createLocalOnlyResolver = () => {
        const repository = new ArtifactRepository(packageWorkspacePath, mockLogger);
        return new ArtifactResolver(repository, undefined, mockLogger);
    };

    beforeEach(() => {
        vi.clearAllMocks();
        resolver = ArtifactResolver.create(packageWorkspacePath, undefined, mockLogger);
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    describe('constructor and create()', () => {
        it('should initialize with package workspace path', () => {
            expect(resolver).toBeDefined();
        });

        it('should default to pnpm registry (falls back to npmjs.org when pnpm CLI unavailable)', () => {
            expect(resolver.getRegistryUrl()).toBe('https://registry.npmjs.org');
        });

        it('should accept an injected registry client via create()', () => {
            const mockClient = createMockRegistryClient();
            const customResolver = ArtifactResolver.create(packageWorkspacePath, {
                registryClient: mockClient,
            }, mockLogger);
            expect(customResolver.getRegistryUrl()).toBe('https://registry.npmjs.org');
            expect(customResolver.hasRegistryClient()).toBe(true);
        });

        it('should allow direct constructor with injected dependencies', () => {
            const repository = new ArtifactRepository(packageWorkspacePath, mockLogger);
            const mockClient = createMockRegistryClient();
            (mockClient.getRegistryUrl as ReturnType<typeof vi.fn>).mockReturnValue('https://injected.registry.com');

            const injectedResolver = new ArtifactResolver(repository, mockClient, mockLogger);

            expect(injectedResolver.getRegistryUrl()).toBe('https://injected.registry.com');
            expect(injectedResolver.getRepository()).toBe(repository);
            expect(injectedResolver.hasRegistryClient()).toBe(true);
        });

        it('should support local-only mode without registry client', () => {
            const localResolver = createLocalOnlyResolver();

            expect(localResolver.getRegistryUrl()).toBeUndefined();
            expect(localResolver.hasRegistryClient()).toBe(false);
        });

        it('should create local-only resolver via create() with localOnly option', () => {
            const customResolver = ArtifactResolver.create(packageWorkspacePath, {
                localOnly: true,
            }, mockLogger);

            expect(customResolver.getRegistryUrl()).toBeUndefined();
            expect(customResolver.hasRegistryClient()).toBe(false);
        });
    });

    describe('resolve', () => {
        describe('local resolution', () => {
            it('should resolve from dist/package.json when available', async () => {
                const distPkgJson = createMockDistPackageJson();

                vi.mocked(fs.pathExists).mockResolvedValue(true as never);
                vi.mocked(fs.readJson).mockResolvedValue(distPkgJson as never);
                vi.mocked(fs.existsSync).mockReturnValue(true);

                const result = await resolver.resolve('@testorg/test-package');

                expect(result.version).toBe('1.0.0-1');
                expect(result.source).toBe('local');
                expect(result.artifactPath).toContain('dist');
            });

            it('should return local version when requested version matches', async () => {
                const distPkgJson = createMockDistPackageJson();

                vi.mocked(fs.pathExists).mockResolvedValue(true as never);
                vi.mocked(fs.readJson).mockResolvedValue(distPkgJson as never);
                vi.mocked(fs.existsSync).mockReturnValue(true);

                const result = await resolver.resolve('@testorg/test-package', { version: '1.0.0-1' });

                expect(result.version).toBe('1.0.0-1');
            });

            it('should check remote when forceRefresh is true', async () => {
                const mockRegistryClient = createMockRegistryClient(['1.0.0-1']);
                const testResolver = createResolverWithMocks(mockRegistryClient);

                const distPkgJson = createMockDistPackageJson();

                vi.mocked(fs.pathExists).mockResolvedValue(true as never);
                vi.mocked(fs.readJson).mockResolvedValue(distPkgJson as never);
                vi.mocked(fs.existsSync).mockReturnValue(true);

                await testResolver.resolve('@testorg/test-package', { forceRefresh: true });

                expect(mockRegistryClient.getVersions).toHaveBeenCalledWith('@testorg/test-package');
            });
        });

        describe('remote resolution', () => {
            it('should check remote when no local build exists', async () => {
                const mockRegistryClient = createMockRegistryClient(['1.0.0-1']);
                const testResolver = createResolverWithMocks(mockRegistryClient);

                // No dist/package.json
                vi.mocked(fs.pathExists).mockResolvedValue(false as never);
                vi.mocked(fs.existsSync).mockReturnValue(false);
                vi.mocked(fs.ensureDir).mockResolvedValue(undefined as never);
                vi.mocked(fs.emptyDir).mockResolvedValue(undefined as never);
                vi.mocked(fs.remove).mockResolvedValue(undefined as never);
                vi.mocked(fs.readJson).mockResolvedValue(createMockDistPackageJson() as never);

                const result = await testResolver.resolve('@testorg/test-package');

                expect(mockRegistryClient.getVersions).toHaveBeenCalled();
                expect(mockRegistryClient.downloadPackage).toHaveBeenCalled();
                expect(result.source).toBe('remote');
            });
        });

        describe('error handling', () => {
            it('should throw ArtifactError when no version found locally or remotely', async () => {
                vi.mocked(fs.pathExists).mockResolvedValue(false as never);
                vi.mocked(fs.existsSync).mockReturnValue(false);

                await expect(
                    resolver.resolve('nonexistent-package')
                ).rejects.toThrow(ArtifactError);
            });

            it('should handle npm registry errors gracefully with local fallback', async () => {
                const mockRegistryClient = createMockRegistryClient();
                mockRegistryClient.getVersions.mockRejectedValue(new Error('Network error'));
                const testResolver = createResolverWithMocks(mockRegistryClient);

                const distPkgJson = createMockDistPackageJson();

                vi.mocked(fs.pathExists).mockResolvedValue(true as never);
                vi.mocked(fs.readJson).mockResolvedValue(distPkgJson as never);
                vi.mocked(fs.existsSync).mockReturnValue(true);

                // forceRefresh to trigger remote check, which will fail
                const result = await testResolver.resolve('@testorg/test-package', { forceRefresh: true });
                
                // Should fall back to local
                expect(result.version).toBe('1.0.0-1');
                expect(result.source).toBe('local');
            });
        });

        describe('packageVersionId extraction', () => {
            it('should include packageVersionId from dist/package.json', async () => {
                const distPkgJson = createMockDistPackageJson();

                vi.mocked(fs.pathExists).mockResolvedValue(true as never);
                vi.mocked(fs.readJson).mockResolvedValue(distPkgJson as never);
                vi.mocked(fs.existsSync).mockReturnValue(true);

                const result = await resolver.resolve('@testorg/test-package');

                expect(result.packageVersionId).toBe('04t1234567890');
                expect(result.manifest.packageVersionId).toBe('04t1234567890');
            });

            it('should return undefined packageVersionId when not present', async () => {
                const distPkgJson = createMockDistPackageJson({
                    sfpm: { packageType: 'source', sourceHash: 'abc123' },
                });

                vi.mocked(fs.pathExists).mockResolvedValue(true as never);
                vi.mocked(fs.readJson).mockResolvedValue(distPkgJson as never);
                vi.mocked(fs.existsSync).mockReturnValue(true);

                const result = await resolver.resolve('@testorg/test-package');

                expect(result.packageVersionId).toBeUndefined();
            });
        });

        describe('manifest shape', () => {
            it('should return ResolvedArtifact with manifest field for backward compatibility', async () => {
                const distPkgJson = createMockDistPackageJson();

                vi.mocked(fs.pathExists).mockResolvedValue(true as never);
                vi.mocked(fs.readJson).mockResolvedValue(distPkgJson as never);
                vi.mocked(fs.existsSync).mockReturnValue(true);

                const result = await resolver.resolve('@testorg/test-package');

                expect(result.manifest).toBeDefined();
                expect(result.manifest.sourceHash).toBe('abc123');
                expect(result.manifest.schemaVersion).toBe(2);
                expect(result.manifest.source).toBe('local');
                expect(result.manifest.name).toBe('@testorg/test-package');
            });
        });
    });

    describe('version selection', () => {
        it('should select highest version from combined local and remote', async () => {
            const mockRegistryClient = createMockRegistryClient(['1.0.0-1', '1.0.0-2', '2.0.0-1']);
            const testResolver = createResolverWithMocks(mockRegistryClient);

            const distPkgJson = createMockDistPackageJson({ version: '1.0.0-1' });

            vi.mocked(fs.pathExists).mockResolvedValue(true as never);
            vi.mocked(fs.readJson).mockResolvedValue(distPkgJson as never);
            vi.mocked(fs.existsSync).mockReturnValue(true);
            vi.mocked(fs.ensureDir).mockResolvedValue(undefined as never);
            vi.mocked(fs.emptyDir).mockResolvedValue(undefined as never);
            vi.mocked(fs.remove).mockResolvedValue(undefined as never);

            const result = await testResolver.resolve('@testorg/test-package', { forceRefresh: true });

            // Should select highest version (2.0.0-1) from remote
            expect(result.version).toBe('2.0.0-1');
            expect(result.source).toBe('remote');
        });
    });
});
