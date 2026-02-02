import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import path from 'path';
import fs from 'fs-extra';
import { ArtifactRepository } from '../../src/artifacts/artifact-repository.js';
import { ArtifactManifest } from '../../src/types/artifact.js';

// Create mock instances
const mockAdmZipInstance = {
    getEntry: vi.fn().mockReturnValue({
        name: 'artifact_metadata.json',
    }),
    readAsText: vi.fn().mockReturnValue(JSON.stringify({
        identity: {
            packageName: 'test-package',
            packageVersionId: '04t1234567890',
        },
    })),
};

// Mock external dependencies
vi.mock('fs-extra');
vi.mock('adm-zip', () => {
    return {
        default: function AdmZip() { return mockAdmZipInstance; },
    };
});

vi.mock('archiver', () => ({
    default: vi.fn().mockImplementation(() => ({
        pipe: vi.fn(),
        directory: vi.fn(),
        finalize: vi.fn(),
        on: vi.fn((event, callback) => {
            if (event === 'close') {
                setTimeout(callback, 0);
            }
        }),
    })),
}));

describe('ArtifactRepository', () => {
    let repository: ArtifactRepository;
    const projectDirectory = '/test/project';

    const mockLogger = {
        log: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        info: vi.fn(),
        debug: vi.fn(),
        trace: vi.fn(),
    };

    const createMockManifest = (overrides?: Partial<ArtifactManifest>): ArtifactManifest => ({
        name: 'test-package',
        latest: '1.0.0-1',
        lastCheckedRemote: Date.now() - 30 * 60 * 1000,
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
            expect(repository.getPackageArtifactPath('my-package')).toBe(
                path.join(projectDirectory, 'artifacts', 'my-package')
            );
        });

        it('should return correct version path', () => {
            expect(repository.getVersionPath('my-package', '1.0.0-1')).toBe(
                path.join(projectDirectory, 'artifacts', 'my-package', '1.0.0-1')
            );
        });

        it('should return correct artifact zip path', () => {
            expect(repository.getArtifactZipPath('my-package', '1.0.0-1')).toBe(
                path.join(projectDirectory, 'artifacts', 'my-package', '1.0.0-1', 'artifact.zip')
            );
        });

        it('should return correct manifest path', () => {
            expect(repository.getManifestPath('my-package')).toBe(
                path.join(projectDirectory, 'artifacts', 'my-package', 'manifest.json')
            );
        });
    });

    describe('existence checks', () => {
        it('should return true if manifest exists', () => {
            vi.mocked(fs.existsSync).mockReturnValue(true);
            expect(repository.hasArtifacts('test-package')).toBe(true);
        });

        it('should return false if manifest does not exist', () => {
            vi.mocked(fs.existsSync).mockReturnValue(false);
            expect(repository.hasArtifacts('test-package')).toBe(false);
        });

        it('should check if version exists in manifest', () => {
            const manifest = createMockManifest();
            vi.mocked(fs.existsSync).mockReturnValue(true);
            vi.mocked(fs.readJsonSync).mockReturnValue(manifest);

            expect(repository.hasVersion('test-package', '1.0.0-1')).toBe(true);
            expect(repository.hasVersion('test-package', '2.0.0-1')).toBe(false);
        });

        it('should check if artifact zip exists', () => {
            vi.mocked(fs.existsSync).mockReturnValue(true);
            expect(repository.artifactZipExists('test-package', '1.0.0-1')).toBe(true);
        });
    });

    describe('manifest operations', () => {
        it('should load manifest async', async () => {
            const manifest = createMockManifest();
            vi.mocked(fs.pathExists).mockResolvedValue(true);
            vi.mocked(fs.readJson).mockResolvedValue(manifest);

            const result = await repository.getManifest('test-package');
            expect(result).toEqual(manifest);
        });

        it('should return undefined if manifest does not exist', async () => {
            vi.mocked(fs.pathExists).mockResolvedValue(false);

            const result = await repository.getManifest('test-package');
            expect(result).toBeUndefined();
        });

        it('should load manifest sync', () => {
            const manifest = createMockManifest();
            vi.mocked(fs.existsSync).mockReturnValue(true);
            vi.mocked(fs.readJsonSync).mockReturnValue(manifest);

            const result = repository.getManifestSync('test-package');
            expect(result).toEqual(manifest);
        });

        it('should save manifest atomically', async () => {
            const manifest = createMockManifest();
            vi.mocked(fs.ensureDir).mockResolvedValue(undefined as any);
            vi.mocked(fs.writeJson).mockResolvedValue(undefined as any);
            vi.mocked(fs.move).mockResolvedValue(undefined as any);

            await repository.saveManifest('test-package', manifest);

            expect(fs.writeJson).toHaveBeenCalled();
            expect(fs.move).toHaveBeenCalled();
        });

        it('should get latest version', () => {
            const manifest = createMockManifest();
            vi.mocked(fs.existsSync).mockReturnValue(true);
            vi.mocked(fs.readJsonSync).mockReturnValue(manifest);

            expect(repository.getLatestVersion('test-package')).toBe('1.0.0-1');
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

            const versions = repository.getVersions('test-package');
            expect(versions).toHaveLength(2);
            expect(versions).toContain('1.0.0-1');
            expect(versions).toContain('1.0.0-2');
        });
    });

    describe('metadata operations', () => {
        it('should get metadata from artifact zip', () => {
            const manifest = createMockManifest();
            vi.mocked(fs.existsSync).mockReturnValue(true);
            vi.mocked(fs.readJsonSync).mockReturnValue(manifest);

            const metadata = repository.getMetadata('test-package');
            expect(metadata).toBeDefined();
            expect(metadata?.identity).toBeDefined();
        });

        it('should extract packageVersionId', () => {
            const manifest = createMockManifest();
            vi.mocked(fs.existsSync).mockReturnValue(true);
            vi.mocked(fs.readJsonSync).mockReturnValue(manifest);

            const versionId = repository.extractPackageVersionId('test-package');
            expect(versionId).toBe('04t1234567890');
        });

        it('should get comprehensive artifact info', () => {
            const manifest = createMockManifest();
            vi.mocked(fs.existsSync).mockReturnValue(true);
            vi.mocked(fs.readJsonSync).mockReturnValue(manifest);

            const info = repository.getArtifactInfo('test-package');
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

            await repository.updateLatestSymlink('test-package', '1.0.0-2');

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

            await repository.updateLatestSymlink('test-package', '1.0.0-2');

            expect(fs.remove).toHaveBeenCalled();
            expect(fs.symlink).toHaveBeenCalled();
        });

        it('should fallback to version file if symlink fails', async () => {
            vi.mocked(fs.pathExists).mockResolvedValue(false);
            vi.mocked(fs.symlink).mockRejectedValue(new Error('Symlink not supported'));
            vi.mocked(fs.writeFile).mockResolvedValue(undefined as any);

            await repository.updateLatestSymlink('test-package', '1.0.0-2');

            expect(fs.writeFile).toHaveBeenCalledWith(
                expect.stringContaining('latest.version'),
                '1.0.0-2'
            );
        });
    });

    describe('directory management', () => {
        it('should ensure version directory exists', async () => {
            vi.mocked(fs.ensureDir).mockResolvedValue(undefined as any);

            const result = await repository.ensureVersionDir('test-package', '1.0.0-1');

            expect(fs.ensureDir).toHaveBeenCalled();
            expect(result).toBe(repository.getVersionPath('test-package', '1.0.0-1'));
        });

        it('should remove version directory', async () => {
            vi.mocked(fs.remove).mockResolvedValue(undefined as any);

            await repository.removeVersion('test-package', '1.0.0-1');

            expect(fs.remove).toHaveBeenCalledWith(
                repository.getVersionPath('test-package', '1.0.0-1')
            );
        });
    });
});
