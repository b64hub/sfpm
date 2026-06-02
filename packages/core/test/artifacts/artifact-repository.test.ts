import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import path from 'path';
import fs from 'fs-extra';
import { execSync } from 'node:child_process';
import { ArtifactRepository } from '../../src/artifacts/artifact-repository.js';
import { ArtifactManifest } from '../../src/types/artifact.js';
import { PackageType, ValidationState } from '../../src/types/package.js';

// Mock package.json content for tgz extraction (flat sfpm metadata structure)
const mockPackageJson = {
    name: '@testorg/test-package',
    version: '1.0.0-1',
    sfpm: {
        packageName: '@testorg/test-package',
        packageType: PackageType.Unlocked,
        versionNumber: '1.0.0-1',
        packageId: '0Ho1234567890',
        packageVersionId: '04t1234567890',
        orchestration: {},
        source: {
            sourceHash: 'abc123',
        },
    }
};

// Mock external dependencies
vi.mock('fs-extra');
vi.mock('node:child_process', () => ({
    execSync: vi.fn().mockImplementation(() => JSON.stringify(mockPackageJson))
}));

describe('ArtifactRepository', () => {
    let repository: ArtifactRepository;
    const packageWorkspacePath = '/test/project/packages/my-pkg';

    const mockLogger = {
        warn: vi.fn(),
        error: vi.fn(),
        info: vi.fn(),
        debug: vi.fn(),
        trace: vi.fn(),
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
        lastCheckedRemote: Date.now() - 30 * 60 * 1000,
        ...overrides,
    });

    beforeEach(() => {
        vi.clearAllMocks();
        repository = new ArtifactRepository(packageWorkspacePath, mockLogger);
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    describe('path resolution', () => {
        it('should return correct artifact path', () => {
            expect(repository.getArtifactPath()).toBe(
                path.join(packageWorkspacePath, 'artifacts', 'artifact.tgz')
            );
        });

        it('should return correct artifacts dir', () => {
            expect(repository.getArtifactsDir()).toBe(
                path.join(packageWorkspacePath, 'artifacts')
            );
        });

        it('should return correct package workspace path', () => {
            expect(repository.getPackageWorkspacePath()).toBe(packageWorkspacePath);
        });
    });

    describe('existence checks', () => {
        it('should return true if manifest exists', () => {
            vi.mocked(fs.existsSync).mockReturnValue(true);
            expect(repository.hasArtifact()).toBe(true);
        });

        it('should return false if manifest does not exist', () => {
            vi.mocked(fs.existsSync).mockReturnValue(false);
            expect(repository.hasArtifact()).toBe(false);
        });

        it('should check if tarball exists', () => {
            vi.mocked(fs.existsSync).mockReturnValue(true);
            expect(repository.hasTarball()).toBe(true);
        });

        it('should return false if tarball does not exist', () => {
            vi.mocked(fs.existsSync).mockReturnValue(false);
            expect(repository.hasTarball()).toBe(false);
        });
    });

    describe('manifest operations', () => {
        it('should load manifest async', async () => {
            const manifest = createMockManifest();
            vi.mocked(fs.pathExists).mockResolvedValue(true);
            vi.mocked(fs.readJson).mockResolvedValue(manifest);

            const result = await repository.getManifest();
            expect(result).toEqual(manifest);
        });

        it('should return undefined if manifest does not exist', async () => {
            vi.mocked(fs.pathExists).mockResolvedValue(false);

            const result = await repository.getManifest();
            expect(result).toBeUndefined();
        });

        it('should load manifest sync', () => {
            const manifest = createMockManifest();
            vi.mocked(fs.existsSync).mockReturnValue(true);
            vi.mocked(fs.readJsonSync).mockReturnValue(manifest);

            const result = repository.getManifestSync();
            expect(result).toEqual(manifest);
        });

        it('should return undefined for sync when manifest does not exist', () => {
            vi.mocked(fs.existsSync).mockReturnValue(false);

            const result = repository.getManifestSync();
            expect(result).toBeUndefined();
        });

        it('should save manifest atomically', async () => {
            const manifest = createMockManifest();
            vi.mocked(fs.ensureDir).mockResolvedValue(undefined as any);
            vi.mocked(fs.writeJson).mockResolvedValue(undefined as any);
            vi.mocked(fs.move).mockResolvedValue(undefined as any);

            await repository.saveManifest(manifest);

            expect(fs.ensureDir).toHaveBeenCalledWith(
                path.join(packageWorkspacePath, 'artifacts')
            );
            expect(fs.writeJson).toHaveBeenCalled();
            expect(fs.move).toHaveBeenCalled();
        });

        it('should update lastCheckedRemote timestamp', async () => {
            const manifest = createMockManifest();
            vi.mocked(fs.pathExists).mockResolvedValue(true);
            vi.mocked(fs.readJson).mockResolvedValue(manifest);
            vi.mocked(fs.ensureDir).mockResolvedValue(undefined as any);
            vi.mocked(fs.writeJson).mockResolvedValue(undefined as any);
            vi.mocked(fs.move).mockResolvedValue(undefined as any);

            await repository.updateLastCheckedRemote();

            // Verify saveManifest was called (via writeJson)
            expect(fs.writeJson).toHaveBeenCalled();
        });
    });

    describe('finalizeArtifact', () => {
        it('should write manifest with correct fields', async () => {
            vi.mocked(fs.ensureDir).mockResolvedValue(undefined as any);
            vi.mocked(fs.writeJson).mockResolvedValue(undefined as any);
            vi.mocked(fs.move).mockResolvedValue(undefined as any);

            await repository.finalizeArtifact(
                '@testorg/test-package',
                '1.0.0-1',
                'artifacthash',
                'sourcehash',
                { commit: 'abc123', packageVersionId: '04t000' }
            );

            expect(fs.writeJson).toHaveBeenCalledWith(
                expect.stringContaining('manifest.json.tmp'),
                expect.objectContaining({
                    name: '@testorg/test-package',
                    version: '1.0.0-1',
                    artifactHash: 'artifacthash',
                    sourceHash: 'sourcehash',
                    commit: 'abc123',
                    packageVersionId: '04t000',
                    schemaVersion: 2,
                    source: 'local',
                    generatedAt: expect.any(Number),
                }),
                { spaces: 4 }
            );
        });

        it('should write manifest without optional fields', async () => {
            vi.mocked(fs.ensureDir).mockResolvedValue(undefined as any);
            vi.mocked(fs.writeJson).mockResolvedValue(undefined as any);
            vi.mocked(fs.move).mockResolvedValue(undefined as any);

            await repository.finalizeArtifact(
                '@testorg/test-package',
                '1.0.0-1',
                'artifacthash',
                'sourcehash',
            );

            expect(fs.writeJson).toHaveBeenCalledWith(
                expect.any(String),
                expect.objectContaining({
                    name: '@testorg/test-package',
                    schemaVersion: 2,
                    source: 'local',
                }),
                { spaces: 4 }
            );
        });
    });

    describe('localizeTarball', () => {
        it('should move tarball, calculate hash, and write manifest', async () => {
            vi.mocked(fs.ensureDir).mockResolvedValue(undefined as any);
            vi.mocked(fs.move).mockResolvedValue(undefined as any);
            vi.mocked(fs.writeJson).mockResolvedValue(undefined as any);
            // Mock createReadStream for hash calculation
            const mockStream = {
                on: vi.fn().mockImplementation(function(this: any, event: string, cb: Function) {
                    if (event === 'end') setTimeout(cb, 0);
                    return this;
                }),
            };
            vi.mocked(fs.createReadStream).mockReturnValue(mockStream as any);

            const result = await repository.localizeTarball(
                '/tmp/download.tgz',
                '@testorg/test-package',
                '1.0.0-1'
            );

            expect(result.artifactPath).toBe(
                path.join(packageWorkspacePath, 'artifacts', 'artifact.tgz')
            );
            expect(result.manifest.source).toBe('remote');
            expect(result.manifest.schemaVersion).toBe(2);
            expect(result.manifest.version).toBe('1.0.0-1');
            expect(fs.move).toHaveBeenCalledWith(
                '/tmp/download.tgz',
                path.join(packageWorkspacePath, 'artifacts', 'artifact.tgz'),
                { overwrite: true }
            );
        });
    });

    describe('metadata extraction', () => {
        it('should extract metadata from tarball', () => {
            vi.mocked(fs.existsSync).mockReturnValue(true);

            const metadata = repository.getMetadata();
            // execSync is mocked to return mockPackageJson
            expect(metadata).toBeDefined();
            expect(metadata?.packageVersionId).toBe('04t1234567890');
        });

        it('should return undefined when tarball does not exist', () => {
            vi.mocked(fs.existsSync).mockReturnValue(false);

            const metadata = repository.getMetadata();
            expect(metadata).toBeUndefined();
        });
    });

    describe('clean', () => {
        it('should remove the artifacts directory', async () => {
            vi.mocked(fs.remove).mockResolvedValue(undefined as any);

            await repository.clean();

            expect(fs.remove).toHaveBeenCalledWith(
                path.join(packageWorkspacePath, 'artifacts')
            );
        });
    });

    describe('updateArtifactValidation', () => {
        const packageName = '@testorg/test-package';
        const version = '1.0.0-1';

        it('should extract, patch, repack and update manifest hash', async () => {
            const passedState: ValidationState = {
                status: 'passed',
                checks: [{ type: 'deploy', status: 'passed' }],
                testCoverage: 85,
            };

            const manifest = createMockManifest();

            // Artifact exists
            vi.mocked(fs.pathExists).mockImplementation(async (p: any) => {
                if (p.endsWith('artifact.tgz')) return true;
                if (p.endsWith('manifest.json')) return true;
                return false;
            });

            // ensureDir for temp directory
            vi.mocked(fs.ensureDir).mockResolvedValue(undefined as any);

            // readJson for package.json inside extracted tarball and manifest
            vi.mocked(fs.readJson).mockImplementation(async (p: any) => {
                if (p.endsWith('package.json')) {
                    return { ...mockPackageJson };
                }
                return manifest;
            });

            vi.mocked(fs.writeJson).mockResolvedValue(undefined as any);
            vi.mocked(fs.remove).mockResolvedValue(undefined as any);
            vi.mocked(fs.move).mockResolvedValue(undefined as any);

            // Mock execSync for tar commands
            const { execSync: mockExec } = await import('node:child_process');

            // Mock calculateFileHash — it uses createReadStream internally
            const hashSpy = vi.spyOn(repository, 'calculateFileHash').mockResolvedValue('newhash789');

            await repository.updateArtifactValidation(packageName, version, passedState);

            // Verify tar extract was called
            expect(mockExec).toHaveBeenCalledWith(
                expect.stringContaining('tar -xzf'),
                expect.objectContaining({ timeout: 30_000 }),
            );

            // Verify package.json was written with validation state
            expect(fs.writeJson).toHaveBeenCalledWith(
                expect.stringContaining('package.json'),
                expect.objectContaining({
                    sfpm: expect.objectContaining({
                        validation: passedState,
                    }),
                }),
                { spaces: 2 },
            );

            // Verify tar repack was called
            expect(mockExec).toHaveBeenCalledWith(
                expect.stringContaining('tar -czf'),
                expect.objectContaining({ timeout: 60_000 }),
            );

            // Verify manifest was updated with new hash
            expect(fs.writeJson).toHaveBeenCalledWith(
                expect.stringContaining('.tmp'),
                expect.objectContaining({
                    versions: expect.objectContaining({
                        [version]: expect.objectContaining({
                            artifactHash: 'newhash789',
                        }),
                    }),
                }),
                { spaces: 4 },
            );

            // Verify temp dir cleanup
            expect(fs.remove).toHaveBeenCalledWith(expect.stringContaining('.repack-tmp'));

            hashSpy.mockRestore();
        });

        it('should throw if artifact does not exist', async () => {
            vi.mocked(fs.pathExists).mockResolvedValue(false);

            const state: ValidationState = {
                status: 'passed',
                checks: [],
            };

            await expect(
                repository.updateArtifactValidation(packageName, version, state),
            ).rejects.toThrow('Artifact not found');
        });

        it('should clean up temp directory even on error', async () => {
            vi.mocked(fs.pathExists).mockResolvedValue(true);
            vi.mocked(fs.ensureDir).mockResolvedValue(undefined as any);
            vi.mocked(fs.remove).mockResolvedValue(undefined as any);

            // Make tar extract fail
            const { execSync: mockExec } = await import('node:child_process');
            vi.mocked(mockExec).mockImplementation(() => {
                throw new Error('tar failed');
            });

            const state: ValidationState = {
                status: 'failed',
                checks: [],
                error: 'Deploy failed',
            };

            await expect(
                repository.updateArtifactValidation(packageName, version, state),
            ).rejects.toThrow('Failed to update artifact validation state');

            // Verify cleanup still happened
            expect(fs.remove).toHaveBeenCalledWith(expect.stringContaining('.repack-tmp'));
        });
    });
});
