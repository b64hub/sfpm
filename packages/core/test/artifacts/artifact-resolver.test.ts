import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs-extra';
import { ArtifactResolver } from '../../src/artifacts/artifact-resolver.js';
import { ArtifactRepository } from '../../src/artifacts/artifact-repository.js';
import { ArtifactManifest } from '../../src/types/artifact.js';
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

    const createMockManifest = (overrides?: Partial<ArtifactManifest>): ArtifactManifest => ({
        name: '@testorg/test-package',
        version: '1.0.0-1',
        sourceHash: 'abc123',
        artifactHash: 'def456',
        generatedAt: Date.now() - 60000,
        schemaVersion: 2,
        source: 'local',
        commit: 'commit123',
        lastCheckedRemote: Date.now() - 30 * 60 * 1000, // 30 minutes ago (within TTL)
        ...overrides,
    });

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
        describe('TTL and cache behavior', () => {
            it('should use local manifest when TTL is valid', async () => {
                const manifest = createMockManifest();

                vi.mocked(fs.pathExists).mockResolvedValue(true as never);
                vi.mocked(fs.readJson).mockResolvedValue(manifest as never);
                vi.mocked(fs.existsSync).mockReturnValue(true);

                const result = await resolver.resolve('@testorg/test-package');

                expect(result.version).toBe('1.0.0-1');
                expect(result.source).toBe('local');
            });

            it('should check remote when TTL is expired', async () => {
                const mockRegistryClient = createMockRegistryClient(['1.0.0-1']);
                const testResolver = createResolverWithMocks(mockRegistryClient);
                
                const manifest = createMockManifest({
                    lastCheckedRemote: Date.now() - 90 * 60 * 1000, // 90 minutes ago (expired)
                });

                vi.mocked(fs.pathExists).mockResolvedValue(true as never);
                vi.mocked(fs.readJson).mockResolvedValue(manifest as never);
                vi.mocked(fs.existsSync).mockReturnValue(true);
                vi.mocked(fs.readJsonSync).mockReturnValue(manifest);
                vi.mocked(fs.writeJson).mockResolvedValue(undefined as never);
                vi.mocked(fs.move).mockResolvedValue(undefined as never);
                vi.mocked(fs.ensureDir).mockResolvedValue(undefined as never);

                const result = await testResolver.resolve('@testorg/test-package');

                expect(result.version).toBe('1.0.0-1');
                expect(result.source).toBe('local');
                expect(mockRegistryClient.getVersions).toHaveBeenCalledWith('@testorg/test-package');
            });

            it('should check remote when forceRefresh is true', async () => {
                const mockRegistryClient = createMockRegistryClient(['1.0.0-1']);
                const testResolver = createResolverWithMocks(mockRegistryClient);
                
                const manifest = createMockManifest(); // Valid TTL

                vi.mocked(fs.pathExists).mockResolvedValue(true as never);
                vi.mocked(fs.readJson).mockResolvedValue(manifest as never);
                vi.mocked(fs.existsSync).mockReturnValue(true);
                vi.mocked(fs.readJsonSync).mockReturnValue(manifest);
                vi.mocked(fs.writeJson).mockResolvedValue(undefined as never);
                vi.mocked(fs.move).mockResolvedValue(undefined as never);
                vi.mocked(fs.ensureDir).mockResolvedValue(undefined as never);

                await testResolver.resolve('@testorg/test-package', { forceRefresh: true });

                expect(mockRegistryClient.getVersions).toHaveBeenCalledWith('@testorg/test-package');
            });
        });

        describe('version selection', () => {
            it('should return the single local version when no version specified', async () => {
                const manifest = createMockManifest();

                vi.mocked(fs.pathExists).mockResolvedValue(true as never);
                vi.mocked(fs.readJson).mockResolvedValue(manifest as never);
                vi.mocked(fs.existsSync).mockReturnValue(true);

                const result = await resolver.resolve('@testorg/test-package');

                expect(result.version).toBe('1.0.0-1');
            });

            it('should return local version when requested version matches', async () => {
                const manifest = createMockManifest();

                vi.mocked(fs.pathExists).mockResolvedValue(true as never);
                vi.mocked(fs.readJson).mockResolvedValue(manifest as never);
                vi.mocked(fs.existsSync).mockReturnValue(true);

                const result = await resolver.resolve('@testorg/test-package', { version: '1.0.0-1' });

                expect(result.version).toBe('1.0.0-1');
            });
        });

        describe('error handling', () => {
            it('should throw ArtifactError when no version found', async () => {
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

                const manifest = createMockManifest({
                    lastCheckedRemote: Date.now() - 90 * 60 * 1000, // Expired TTL
                });

                vi.mocked(fs.pathExists).mockResolvedValue(true as never);
                vi.mocked(fs.readJson).mockResolvedValue(manifest as never);
                vi.mocked(fs.existsSync).mockReturnValue(true);
                vi.mocked(fs.writeJson).mockResolvedValue(undefined as never);
                vi.mocked(fs.move).mockResolvedValue(undefined as never);
                vi.mocked(fs.ensureDir).mockResolvedValue(undefined as never);

                const result = await testResolver.resolve('@testorg/test-package');
                expect(result.version).toBe('1.0.0-1');
            });
        });

        describe('packageVersionId extraction', () => {
            it('should include packageVersionId from manifest if present', async () => {
                const manifest = createMockManifest({
                    packageVersionId: '04t1234567890',
                });

                vi.mocked(fs.pathExists).mockResolvedValue(true as never);
                vi.mocked(fs.readJson).mockResolvedValue(manifest as never);
                vi.mocked(fs.existsSync).mockReturnValue(true);

                const result = await resolver.resolve('@testorg/test-package');

                expect(result.manifest.packageVersionId).toBe('04t1234567890');
            });
        });

        describe('manifest shape', () => {
            it('should return ResolvedArtifact with manifest field', async () => {
                const manifest = createMockManifest();

                vi.mocked(fs.pathExists).mockResolvedValue(true as never);
                vi.mocked(fs.readJson).mockResolvedValue(manifest as never);
                vi.mocked(fs.existsSync).mockReturnValue(true);

                const result = await resolver.resolve('@testorg/test-package');

                expect(result.manifest).toBeDefined();
                expect(result.manifest.sourceHash).toBe('abc123');
                expect(result.manifest.artifactHash).toBe('def456');
                expect(result.manifest.schemaVersion).toBe(2);
            });
        });
    });

    describe('TTL calculation', () => {
        it('should treat missing lastCheckedRemote as expired', async () => {
            const mockRegistryClient = createMockRegistryClient(['1.0.0-1']);
            const testResolver = createResolverWithMocks(mockRegistryClient);
            
            const manifest = createMockManifest({
                lastCheckedRemote: undefined,
            });

            vi.mocked(fs.pathExists).mockResolvedValue(true as never);
            vi.mocked(fs.readJson).mockResolvedValue(manifest as never);
            vi.mocked(fs.existsSync).mockReturnValue(true);
            vi.mocked(fs.readJsonSync).mockReturnValue(manifest);
            vi.mocked(fs.writeJson).mockResolvedValue(undefined as never);
            vi.mocked(fs.move).mockResolvedValue(undefined as never);
            vi.mocked(fs.ensureDir).mockResolvedValue(undefined as never);

            await testResolver.resolve('@testorg/test-package');

            expect(mockRegistryClient.getVersions).toHaveBeenCalledWith('@testorg/test-package');
        });

        it('should respect custom TTL setting', async () => {
            const mockRegistryClient = createMockRegistryClient(['1.0.0-1']);
            const testResolver = createResolverWithMocks(mockRegistryClient);
            
            const manifest = createMockManifest({
                lastCheckedRemote: Date.now() - 10 * 60 * 1000, // 10 minutes ago
            });

            vi.mocked(fs.pathExists).mockResolvedValue(true as never);
            vi.mocked(fs.readJson).mockResolvedValue(manifest as never);
            vi.mocked(fs.existsSync).mockReturnValue(true);
            vi.mocked(fs.readJsonSync).mockReturnValue(manifest);
            vi.mocked(fs.writeJson).mockResolvedValue(undefined as never);
            vi.mocked(fs.move).mockResolvedValue(undefined as never);
            vi.mocked(fs.ensureDir).mockResolvedValue(undefined as never);

            // With 5 minute TTL, 10 minutes ago should be expired
            await testResolver.resolve('@testorg/test-package', { ttlMinutes: 5 });

            expect(mockRegistryClient.getVersions).toHaveBeenCalledWith('@testorg/test-package');
        });
    });
});
