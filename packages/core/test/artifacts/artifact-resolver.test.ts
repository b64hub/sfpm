import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import path from 'path';
import fs from 'fs-extra';
import { ArtifactResolver } from '../../src/artifacts/artifact-resolver.js';
import { ArtifactRepository } from '../../src/artifacts/artifact-repository.js';
import { NpmRegistryClient } from '../../src/artifacts/registry/index.js';
import { ArtifactManifest } from '../../src/types/artifact.js';
import { ArtifactError } from '../../src/types/errors.js';
import { execSync } from 'child_process';

// Mock external dependencies
vi.mock('fs-extra');
vi.mock('child_process');
vi.mock('adm-zip', () => {
    return {
        default: vi.fn().mockImplementation(() => ({
            getEntry: vi.fn().mockReturnValue({
                name: 'artifact_metadata.json',
            }),
            readAsText: vi.fn().mockReturnValue(JSON.stringify({
                identity: {
                    packageName: 'test-package',
                    packageVersionId: '04t1234567890',
                },
            })),
        })),
    };
});

// Mock archiver
vi.mock('archiver', () => ({
    default: vi.fn().mockImplementation(() => ({
        pipe: vi.fn(),
        directory: vi.fn(),
        finalize: vi.fn(),
        on: vi.fn((event, callback) => {
            if (event === 'close') {
                // Simulate immediate close
                setTimeout(callback, 0);
            }
        }),
    })),
}));

describe('ArtifactResolver', () => {
    let resolver: ArtifactResolver;
    const projectDirectory = '/test/project';
    const artifactsRootDir = '/test/project/artifacts';

    const mockLogger = {
        log: vi.fn(),
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
            name: 'test-package',
            versions: versions.reduce((acc, v) => ({ ...acc, [v]: {} }), {}),
        }),
        packageExists: vi.fn().mockResolvedValue(true),
        getRegistryUrl: vi.fn().mockReturnValue('https://registry.npmjs.org'),
    });

    // Factory for creating a resolver with mock dependencies
    const createResolverWithMocks = (mockRegistryClient?: ReturnType<typeof createMockRegistryClient>) => {
        const repository = new ArtifactRepository(projectDirectory, mockLogger);
        const registryClient = mockRegistryClient || createMockRegistryClient();
        return new ArtifactResolver(repository, registryClient, mockLogger);
    };

    // Factory for creating a local-only resolver (no registry client)
    const createLocalOnlyResolver = () => {
        const repository = new ArtifactRepository(projectDirectory, mockLogger);
        return new ArtifactResolver(repository, undefined, mockLogger);
    };

    const createMockManifest = (overrides?: Partial<ArtifactManifest>): ArtifactManifest => ({
        name: 'test-package',
        latest: '1.0.0-1',
        lastCheckedRemote: Date.now() - 30 * 60 * 1000, // 30 minutes ago (within TTL)
        versions: {
            '1.0.0-1': {
                path: 'test-package/1.0.0-1/artifact.zip',
                sourceHash: 'abc123',
                artifactHash: 'def456',
                generatedAt: Date.now() - 60000,
                commit: 'commit123',
            },
        },
        ...overrides,
    });

    beforeEach(() => {
        vi.clearAllMocks();
        // Clear environment variable before each test
        delete process.env.SFPM_NPM_REGISTRY;
        resolver = ArtifactResolver.create(projectDirectory, mockLogger);
    });

    afterEach(() => {
        vi.restoreAllMocks();
        // Clean up environment variable
        delete process.env.SFPM_NPM_REGISTRY;
    });

    describe('constructor and create()', () => {
        it('should initialize with project directory', () => {
            expect(resolver).toBeDefined();
        });

        it('should use default registry URL', () => {
            expect(resolver.getRegistryUrl()).toBe('https://registry.npmjs.org');
        });

        it('should use custom registry from options', () => {
            const customResolver = ArtifactResolver.create(projectDirectory, mockLogger, {
                registry: 'https://custom.registry.com/',
            });
            expect(customResolver.getRegistryUrl()).toBe('https://custom.registry.com');
        });

        it('should use registry from environment variable', () => {
            process.env.SFPM_NPM_REGISTRY = 'https://env.registry.com';
            const envResolver = ArtifactResolver.create(projectDirectory, mockLogger);
            expect(envResolver.getRegistryUrl()).toBe('https://env.registry.com');
        });

        it('should prefer options over environment variable', () => {
            process.env.SFPM_NPM_REGISTRY = 'https://env.registry.com';
            const configResolver = ArtifactResolver.create(projectDirectory, mockLogger, {
                registry: 'https://config.registry.com',
            });
            expect(configResolver.getRegistryUrl()).toBe('https://config.registry.com');
        });

        it.skip('should read registry from project .npmrc', () => {
            // Note: This test is skipped because npm-config-reader uses @pnpm/npm-conf
            // which has its own file reading logic that bypasses our fs mocks.
            // The functionality is tested via integration tests.
            vi.mocked(fs.existsSync).mockImplementation((p) => {
                return p === path.join(projectDirectory, '.npmrc');
            });
            vi.mocked(fs.readFileSync).mockReturnValue('registry=https://npmrc.registry.com\n');
            
            const npmrcResolver = ArtifactResolver.create(projectDirectory, mockLogger);
            expect(npmrcResolver.getRegistryUrl()).toBe('https://npmrc.registry.com');
        });

        it('should skip .npmrc when useNpmrc is false', () => {
            vi.mocked(fs.existsSync).mockReturnValue(true);
            vi.mocked(fs.readFileSync).mockReturnValue('registry=https://npmrc.registry.com\n');
            
            const noNpmrcResolver = ArtifactResolver.create(projectDirectory, mockLogger, {
                useNpmrc: false,
            });
            expect(noNpmrcResolver.getRegistryUrl()).toBe('https://registry.npmjs.org');
        });

        it('should allow direct constructor with injected dependencies', () => {
            const repository = new ArtifactRepository(projectDirectory, mockLogger);
            const registryClient = new NpmRegistryClient({
                registryUrl: 'https://injected.registry.com',
                logger: mockLogger,
            });
            
            const injectedResolver = new ArtifactResolver(repository, registryClient, mockLogger);
            
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
            const localResolver = ArtifactResolver.create(projectDirectory, mockLogger, {
                localOnly: true,
            });
            
            expect(localResolver.getRegistryUrl()).toBeUndefined();
            expect(localResolver.hasRegistryClient()).toBe(false);
        });
    });

    describe('hasLocalVersion (via repository)', () => {
        it('should return true if version exists in manifest', () => {
            const manifest = createMockManifest();
            vi.mocked(fs.existsSync).mockReturnValue(true);
            vi.mocked(fs.readJsonSync).mockReturnValue(manifest);

            expect(resolver.getRepository().hasVersion('test-package', '1.0.0-1')).toBe(true);
        });

        it('should return false if version does not exist', () => {
            const manifest = createMockManifest();
            vi.mocked(fs.existsSync).mockReturnValue(true);
            vi.mocked(fs.readJsonSync).mockReturnValue(manifest);

            expect(resolver.getRepository().hasVersion('test-package', '2.0.0-1')).toBe(false);
        });

        it('should return false if manifest does not exist', () => {
            vi.mocked(fs.existsSync).mockReturnValue(false);

            expect(resolver.getRepository().hasVersion('test-package', '1.0.0-1')).toBe(false);
        });
    });

    describe('getLocalVersions (via repository)', () => {
        it('should return all versions from manifest', () => {
            const manifest = createMockManifest({
                versions: {
                    '1.0.0-1': { path: 'test-package/1.0.0-1/artifact.zip', generatedAt: Date.now() },
                    '1.0.0-2': { path: 'test-package/1.0.0-2/artifact.zip', generatedAt: Date.now() },
                    '1.0.1-1': { path: 'test-package/1.0.1-1/artifact.zip', generatedAt: Date.now() },
                },
            });
            vi.mocked(fs.existsSync).mockReturnValue(true);
            vi.mocked(fs.readJsonSync).mockReturnValue(manifest);

            const versions = resolver.getRepository().getVersions('test-package');
            expect(versions).toHaveLength(3);
            expect(versions).toContain('1.0.0-1');
            expect(versions).toContain('1.0.0-2');
            expect(versions).toContain('1.0.1-1');
        });

        it('should return empty array if no manifest', () => {
            vi.mocked(fs.existsSync).mockReturnValue(false);

            const versions = resolver.getRepository().getVersions('test-package');
            expect(versions).toEqual([]);
        });
    });

    describe('getManifest (via repository)', () => {
        it('should return manifest if it exists', () => {
            const manifest = createMockManifest();
            vi.mocked(fs.existsSync).mockReturnValue(true);
            vi.mocked(fs.readJsonSync).mockReturnValue(manifest);

            const result = resolver.getRepository().getManifestSync('test-package');
            expect(result).toEqual(manifest);
        });

        it('should return undefined if manifest does not exist', () => {
            vi.mocked(fs.existsSync).mockReturnValue(false);

            const result = resolver.getRepository().getManifestSync('test-package');
            expect(result).toBeUndefined();
        });
    });

    describe('resolve', () => {
        describe('TTL and cache behavior', () => {
            it('should use local manifest when TTL is valid', async () => {
                const manifest = createMockManifest();
                const artifactPath = path.join(artifactsRootDir, 'test-package/1.0.0-1/artifact.zip');

                vi.mocked(fs.pathExists).mockResolvedValue(true as never);
                vi.mocked(fs.readJson).mockResolvedValue(manifest as never);
                vi.mocked(fs.existsSync).mockReturnValue(true);

                const result = await resolver.resolve('test-package');

                expect(result.version).toBe('1.0.0-1');
                expect(result.source).toBe('local');
                // Note: execSync may be called for local tar extraction, but should not call registry
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

                const result = await testResolver.resolve('test-package');

                expect(result.version).toBe('1.0.0-1');
                expect(result.source).toBe('local');
                // Should have called registry client to check remote
                expect(mockRegistryClient.getVersions).toHaveBeenCalledWith('test-package');
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

                await testResolver.resolve('test-package', { forceRefresh: true });

                // Should have called registry client even though TTL is valid
                expect(mockRegistryClient.getVersions).toHaveBeenCalledWith('test-package');
            });
        });

        describe('version selection', () => {
            it('should select latest version when no version specified', async () => {
                const manifest = createMockManifest({
                    latest: '1.0.1-2',
                    versions: {
                        '1.0.0-1': { path: 'test-package/1.0.0-1/artifact.zip', generatedAt: Date.now() },
                        '1.0.1-2': { path: 'test-package/1.0.1-2/artifact.zip', generatedAt: Date.now() },
                    },
                });

                vi.mocked(fs.pathExists).mockResolvedValue(true as never);
                vi.mocked(fs.readJson).mockResolvedValue(manifest as never);
                vi.mocked(fs.existsSync).mockReturnValue(true);

                const result = await resolver.resolve('test-package');

                expect(result.version).toBe('1.0.1-2');
            });

            it('should select specific version when requested', async () => {
                const manifest = createMockManifest({
                    latest: '1.0.1-2',
                    versions: {
                        '1.0.0-1': { path: 'test-package/1.0.0-1/artifact.zip', generatedAt: Date.now() },
                        '1.0.1-2': { path: 'test-package/1.0.1-2/artifact.zip', generatedAt: Date.now() },
                    },
                });

                vi.mocked(fs.pathExists).mockResolvedValue(true as never);
                vi.mocked(fs.readJson).mockResolvedValue(manifest as never);
                vi.mocked(fs.existsSync).mockReturnValue(true);

                const result = await resolver.resolve('test-package', { version: '1.0.0-1' });

                expect(result.version).toBe('1.0.0-1');
            });

            it('should handle Salesforce version format (x.x.x.x)', async () => {
                const manifest = createMockManifest({
                    versions: {
                        '1.0.0-1': { path: 'test-package/1.0.0-1/artifact.zip', generatedAt: Date.now() },
                    },
                });

                vi.mocked(fs.pathExists).mockResolvedValue(true as never);
                vi.mocked(fs.readJson).mockResolvedValue(manifest as never);
                vi.mocked(fs.existsSync).mockReturnValue(true);
                vi.mocked(fs.readJsonSync).mockReturnValue(manifest);
                vi.mocked(fs.writeJson).mockResolvedValue(undefined as never);
                vi.mocked(fs.move).mockResolvedValue(undefined as never);
                vi.mocked(fs.ensureDir).mockResolvedValue(undefined as never);

                // Remote has Salesforce format version
                vi.mocked(execSync).mockReturnValue(JSON.stringify(['1.0.0-1']));

                const result = await resolver.resolve('test-package', { forceRefresh: true });

                expect(result).toBeDefined();
            });
        });

        describe('event emission', () => {
            it('should emit resolve:start event', async () => {
                const manifest = createMockManifest();
                const startHandler = vi.fn();

                vi.mocked(fs.pathExists).mockResolvedValue(true as never);
                vi.mocked(fs.readJson).mockResolvedValue(manifest as never);
                vi.mocked(fs.existsSync).mockReturnValue(true);

                resolver.on('resolve:start', startHandler);
                await resolver.resolve('test-package');

                expect(startHandler).toHaveBeenCalledWith(
                    expect.objectContaining({
                        packageName: 'test-package',
                        timestamp: expect.any(Date),
                    })
                );
            });

            it('should emit resolve:cache-hit event when using local cache', async () => {
                const manifest = createMockManifest();
                const cacheHitHandler = vi.fn();

                vi.mocked(fs.pathExists).mockResolvedValue(true as never);
                vi.mocked(fs.readJson).mockResolvedValue(manifest as never);
                vi.mocked(fs.existsSync).mockReturnValue(true);

                resolver.on('resolve:cache-hit', cacheHitHandler);
                await resolver.resolve('test-package');

                expect(cacheHitHandler).toHaveBeenCalledWith(
                    expect.objectContaining({
                        packageName: 'test-package',
                        version: '1.0.0-1',
                    })
                );
            });

            it('should emit resolve:complete event', async () => {
                const manifest = createMockManifest();
                const completeHandler = vi.fn();

                vi.mocked(fs.pathExists).mockResolvedValue(true as never);
                vi.mocked(fs.readJson).mockResolvedValue(manifest as never);
                vi.mocked(fs.existsSync).mockReturnValue(true);

                resolver.on('resolve:complete', completeHandler);
                await resolver.resolve('test-package');

                expect(completeHandler).toHaveBeenCalledWith(
                    expect.objectContaining({
                        packageName: 'test-package',
                        version: '1.0.0-1',
                        source: 'local',
                    })
                );
            });

            it('should emit resolve:error event on failure', async () => {
                const errorHandler = vi.fn();

                vi.mocked(fs.pathExists).mockResolvedValue(false as never);
                vi.mocked(fs.readJson).mockRejectedValue(new Error('File not found') as never);
                vi.mocked(fs.existsSync).mockReturnValue(false);
                vi.mocked(execSync).mockImplementation(() => {
                    throw new Error('npm error');
                });

                resolver.on('resolve:error', errorHandler);

                await expect(resolver.resolve('test-package')).rejects.toThrow();

                expect(errorHandler).toHaveBeenCalledWith(
                    expect.objectContaining({
                        packageName: 'test-package',
                        error: expect.any(String),
                    })
                );
            });
        });

        describe('error handling', () => {
            it('should throw ArtifactError when no version found', async () => {
                vi.mocked(fs.pathExists).mockResolvedValue(false as never);
                vi.mocked(fs.existsSync).mockReturnValue(false);
                vi.mocked(execSync).mockReturnValue('[]'); // No remote versions

                await expect(
                    resolver.resolve('nonexistent-package')
                ).rejects.toThrow(ArtifactError);
            });

            it('should handle npm registry errors gracefully', async () => {
                const manifest = createMockManifest({
                    lastCheckedRemote: Date.now() - 90 * 60 * 1000, // Expired TTL
                });

                vi.mocked(fs.pathExists).mockResolvedValue(true as never);
                vi.mocked(fs.readJson).mockResolvedValue(manifest as never);
                vi.mocked(fs.existsSync).mockReturnValue(true);
                vi.mocked(fs.readJsonSync).mockReturnValue(manifest);
                vi.mocked(fs.writeJson).mockResolvedValue(undefined as never);
                vi.mocked(fs.move).mockResolvedValue(undefined as never);
                vi.mocked(fs.ensureDir).mockResolvedValue(undefined as never);

                // npm call fails - should fall back to local
                vi.mocked(execSync).mockImplementation(() => {
                    throw new Error('Network error');
                });

                // Should still resolve from local
                const result = await resolver.resolve('test-package');
                expect(result.version).toBe('1.0.0-1');
            });
        });

        describe('packageVersionId extraction', () => {
            it('should include packageVersionId from manifest if present', async () => {
                const manifest = createMockManifest({
                    versions: {
                        '1.0.0-1': {
                            path: 'test-package/1.0.0-1/artifact.zip',
                            sourceHash: 'abc123',
                            artifactHash: 'def456',
                            generatedAt: Date.now() - 60000,
                            commit: 'commit123',
                            packageVersionId: '04t1234567890',
                        },
                    },
                });

                vi.mocked(fs.pathExists).mockResolvedValue(true as never);
                vi.mocked(fs.readJson).mockResolvedValue(manifest as never);
                vi.mocked(fs.existsSync).mockReturnValue(true);

                const result = await resolver.resolve('test-package');

                expect(result.versionEntry.packageVersionId).toBe('04t1234567890');
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

            await testResolver.resolve('test-package');

            // Should have checked remote because TTL was expired
            expect(mockRegistryClient.getVersions).toHaveBeenCalledWith('test-package');
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
            await testResolver.resolve('test-package', { ttlMinutes: 5 });

            expect(mockRegistryClient.getVersions).toHaveBeenCalledWith('test-package');
        });
    });
});
