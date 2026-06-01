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
    const projectDirectory = '/test/project';

    const mockLogger = {
        warn: vi.fn(),
        error: vi.fn(),
        info: vi.fn(),
        debug: vi.fn(),
        trace: vi.fn(),
    };

    const createMockManifest = (overrides?: Partial<ArtifactManifest>): ArtifactManifest => ({
        name: '@testorg/test-package',
        latest: '1.0.0-1',
        lastCheckedRemote: Date.now() - 30 * 60 * 1000,
        versions: {
            '1.0.0-1': {
                path: 'test-package/1.0.0-1/artifact.tgz',
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
        repository = new ArtifactRepository(projectDirectory, mockLogger);
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    describe('path resolution', () => {
        it('should return correct artifacts root', () => {
            expect(repository.getArtifactsRoot()).toBe(path.join(projectDirectory, 'artifacts'));
        });

        it('should return correct package artifact path', () => {
            expect(repository.getPackageArtifactPath('@testorg/my-package')).toBe(
                path.join(projectDirectory, 'artifacts', '@testorg/my-package')
            );
        });

        it('should return correct version path', () => {
            expect(repository.getVersionPath('@testorg/my-package', '1.0.0-1')).toBe(
                path.join(projectDirectory, 'artifacts', '@testorg/my-package', '1.0.0-1')
            );
        });

        it('should return correct artifact tgz path', () => {
            expect(repository.getArtifactPath('@testorg/my-package', '1.0.0-1')).toBe(
                path.join(projectDirectory, 'artifacts', '@testorg/my-package', '1.0.0-1', 'artifact.tgz')
            );
        });

        it('should return correct manifest path', () => {
            expect(repository.getManifestPath('@testorg/my-package')).toBe(
                path.join(projectDirectory, 'artifacts', '@testorg/my-package', 'manifest.json')
            );
        });
    });

    describe('existence checks', () => {
        it('should return true if manifest exists', () => {
            vi.mocked(fs.existsSync).mockReturnValue(true);
            expect(repository.hasArtifacts('@testorg/test-package')).toBe(true);
        });

        it('should return false if manifest does not exist', () => {
            vi.mocked(fs.existsSync).mockReturnValue(false);
            expect(repository.hasArtifacts('@testorg/test-package')).toBe(false);
        });

        it('should check if version exists in manifest', () => {
            const manifest = createMockManifest();
            vi.mocked(fs.existsSync).mockReturnValue(true);
            vi.mocked(fs.readJsonSync).mockReturnValue(manifest);

            expect(repository.hasVersion('@testorg/test-package', '1.0.0-1')).toBe(true);
            expect(repository.hasVersion('@testorg/test-package', '2.0.0-1')).toBe(false);
        });

        it('should check if artifact tgz exists', () => {
            vi.mocked(fs.existsSync).mockReturnValue(true);
            expect(repository.artifactExists('@testorg/test-package', '1.0.0-1')).toBe(true);
        });
    });

    describe('manifest operations', () => {
        it('should load manifest async', async () => {
            const manifest = createMockManifest();
            vi.mocked(fs.pathExists).mockResolvedValue(true);
            vi.mocked(fs.readJson).mockResolvedValue(manifest);

            const result = await repository.getManifest('@testorg/test-package');
            expect(result).toEqual(manifest);
        });

        it('should return undefined if manifest does not exist', async () => {
            vi.mocked(fs.pathExists).mockResolvedValue(false);

            const result = await repository.getManifest('@testorg/test-package');
            expect(result).toBeUndefined();
        });

        it('should load manifest sync', () => {
            const manifest = createMockManifest();
            vi.mocked(fs.existsSync).mockReturnValue(true);
            vi.mocked(fs.readJsonSync).mockReturnValue(manifest);

            const result = repository.getManifestSync('@testorg/test-package');
            expect(result).toEqual(manifest);
        });

        it('should save manifest atomically', async () => {
            const manifest = createMockManifest();
            vi.mocked(fs.ensureDir).mockResolvedValue(undefined as any);
            vi.mocked(fs.writeJson).mockResolvedValue(undefined as any);
            vi.mocked(fs.move).mockResolvedValue(undefined as any);

            await repository.saveManifest('@testorg/test-package', manifest);

            expect(fs.writeJson).toHaveBeenCalled();
            expect(fs.move).toHaveBeenCalled();
        });

        it('should get latest version', () => {
            const manifest = createMockManifest();
            vi.mocked(fs.existsSync).mockReturnValue(true);
            vi.mocked(fs.readJsonSync).mockReturnValue(manifest);

            expect(repository.getLatestVersion('@testorg/test-package')).toBe('1.0.0-1');
        });

        it('should get all versions', () => {
            const manifest = createMockManifest({
                versions: {
                    '1.0.0-1': { path: 'test', generatedAt: Date.now() },
                    '1.0.0-2': { path: 'test', generatedAt: Date.now() },
                },
            });
            vi.mocked(fs.existsSync).mockReturnValue(true);
            vi.mocked(fs.readJsonSync).mockReturnValue(manifest);

            const versions = repository.getVersions('@testorg/test-package');
            expect(versions).toHaveLength(2);
            expect(versions).toContain('1.0.0-1');
            expect(versions).toContain('1.0.0-2');
        });
    });

    describe('metadata operations', () => {
        it('should get metadata from artifact tgz', () => {
            const manifest = createMockManifest();
            vi.mocked(fs.readJsonSync).mockReturnValue(manifest);
            vi.mocked(fs.existsSync).mockImplementation((p: any) => {
                return p.endsWith('manifest.json') || p.endsWith('artifact.tgz');
            });

            const metadata = repository.getMetadata('@testorg/test-package');
            expect(metadata).toBeDefined();
            expect(metadata?.packageVersionId).toBe('04t1234567890');
        });

        it('should extract packageVersionId', () => {
            const manifest = createMockManifest();
            vi.mocked(fs.readJsonSync).mockReturnValue(manifest);
            vi.mocked(fs.existsSync).mockImplementation((p: any) => {
                return p.endsWith('manifest.json') || p.endsWith('artifact.tgz');
            });

            const versionId = repository.extractPackageVersionId('@testorg/test-package');
            expect(versionId).toBe('04t1234567890');
        });

        it('should get comprehensive artifact info', () => {
            const manifest = createMockManifest();
            vi.mocked(fs.readJsonSync).mockReturnValue(manifest);
            vi.mocked(fs.existsSync).mockImplementation((p: any) => {
                return p.endsWith('manifest.json') || p.endsWith('artifact.tgz');
            });

            const info = repository.getArtifactInfo('@testorg/test-package');
            expect(info.version).toBe('1.0.0-1');
            expect(info.manifest).toBeDefined();
            expect(info.metadata).toBeDefined();
            expect(info.versionInfo).toBeDefined();
        });
    });

    describe('symlink management', () => {
        it('should update latest symlink', async () => {
            vi.mocked(fs.pathExists).mockResolvedValue(false);
            vi.mocked(fs.symlink).mockResolvedValue(undefined as any);

            await repository.updateLatestSymlink('@testorg/test-package', '1.0.0-2');

            expect(fs.symlink).toHaveBeenCalledWith(
                '1.0.0-2',
                expect.stringContaining('latest'),
                'junction'
            );
        });

        it('should remove existing symlink before creating new one', async () => {
            vi.mocked(fs.pathExists).mockResolvedValue(true);
            vi.mocked(fs.remove).mockResolvedValue(undefined as any);
            vi.mocked(fs.symlink).mockResolvedValue(undefined as any);

            await repository.updateLatestSymlink('@testorg/test-package', '1.0.0-2');

            expect(fs.remove).toHaveBeenCalled();
            expect(fs.symlink).toHaveBeenCalled();
        });

        it('should fallback to version file if symlink fails', async () => {
            vi.mocked(fs.pathExists).mockResolvedValue(false);
            vi.mocked(fs.symlink).mockRejectedValue(new Error('Symlink not supported'));
            vi.mocked(fs.writeFile).mockResolvedValue(undefined as any);

            await repository.updateLatestSymlink('@testorg/test-package', '1.0.0-2');

            expect(fs.writeFile).toHaveBeenCalledWith(
                expect.stringContaining('latest.version'),
                '1.0.0-2'
            );
        });
    });

    describe('directory management', () => {
        it('should ensure version directory exists', async () => {
            vi.mocked(fs.ensureDir).mockResolvedValue(undefined as any);

            const result = await repository.ensureVersionDir('@testorg/test-package', '1.0.0-1');

            expect(fs.ensureDir).toHaveBeenCalled();
            expect(result).toBe(repository.getVersionPath('@testorg/test-package', '1.0.0-1'));
        });

        it('should remove version directory', async () => {
            vi.mocked(fs.remove).mockResolvedValue(undefined as any);

            await repository.removeVersion('@testorg/test-package', '1.0.0-1');

            expect(fs.remove).toHaveBeenCalledWith(
                repository.getVersionPath('@testorg/test-package', '1.0.0-1')
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
