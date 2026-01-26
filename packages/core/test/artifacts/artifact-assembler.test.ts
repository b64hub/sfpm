import { describe, it, expect, vi, beforeEach } from 'vitest';
import path from 'path';
import * as fs from 'fs-extra';
import archiver from 'archiver';
import ArtifactAssembler from '../../src/artifacts/artifact-assembler.js';
import { VersionManager } from '../../src/project/version-manager.js';

vi.mock('fs-extra', () => {
    const mocks = {
        ensureDir: vi.fn(),
        pathExists: vi.fn<(path: string) => Promise<boolean>>(),
        remove: vi.fn(),
        copy: vi.fn(),
        writeJSON: vi.fn(),
        readJSON: vi.fn(),
        symlink: vi.fn(),
        writeFile: vi.fn(),
        createWriteStream: vi.fn(),
    };
    return {
        ...mocks,
        default: mocks
    };
});

vi.mock('archiver', () => ({
    default: vi.fn(() => ({
        pipe: vi.fn(),
        directory: vi.fn(),
        finalize: vi.fn(),
        on: vi.fn()
    }))
}));

vi.mock('../../src/project/version-manager.js', () => ({
    VersionManager: {
        normalizeVersion: vi.fn()
    }
}));

describe('ArtifactAssembler', () => {
    let mockSfpmPackage: any;
    let mockLogger: any;
    let mockChangelogProvider: any;
    let assembler: ArtifactAssembler;

    const artifactsRootDir = '/artifacts';
    const projectDirectory = '/project';
    const packageName = 'my-package';
    const version = '1.0.0.1';

    beforeEach(() => {
        vi.resetAllMocks();

        mockSfpmPackage = {
            packageName,
            version,
            stagingDirectory: '/tmp/staging',
            toPackageMetadata: vi.fn().mockResolvedValue({ some: 'metadata' })
        };

        mockLogger = {
            info: vi.fn(),
            error: vi.fn(),
            warn: vi.fn()
        };

        mockChangelogProvider = {
            generateChangelog: vi.fn().mockResolvedValue({ commits: [] })
        };

        vi.mocked(VersionManager.normalizeVersion).mockReturnValue(version);

        assembler = new ArtifactAssembler(
            mockSfpmPackage,
            projectDirectory,
            artifactsRootDir,
            mockLogger,
            mockChangelogProvider
        );
    });

    it('should initialize with correct paths', () => {
        expect((assembler as any).packageArtifactRoot).toBe(path.join(artifactsRootDir, packageName));
        expect((assembler as any).versionDirectory).toBe(path.join(artifactsRootDir, packageName, version));
    });

    describe('assemble', () => {
        it('should orchestrate the assembly process successfully', async () => {
            // Mock sub-methods or their dependencies
            vi.mocked(fs.ensureDir).mockResolvedValue(undefined as any);
            vi.mocked(fs.pathExists).mockResolvedValue(true);
            vi.mocked(fs.remove).mockResolvedValue(undefined as any);
            vi.mocked(fs.copy).mockResolvedValue(undefined as any);
            vi.mocked(fs.writeJSON).mockResolvedValue(undefined as any);
            vi.mocked(fs.readJSON).mockResolvedValue({ versions: {} });
            vi.mocked(fs.symlink).mockResolvedValue(undefined as any);

            // Mock archiver
            const mockArchive = {
                pipe: vi.fn(),
                directory: vi.fn(),
                finalize: vi.fn(),
                on: vi.fn((event, cb) => {
                    if (event === 'close') {
                        // This matches the output stream on close, but archiver also has on events
                    }
                })
            };
            vi.mocked(archiver).mockReturnValue(mockArchive as any);

            // Mock fs.createWriteStream
            const mockStream = {
                on: vi.fn((event, cb) => {
                    if (event === 'close') setTimeout(cb, 0);
                    return mockStream;
                })
            };
            vi.mocked(fs.createWriteStream).mockReturnValue(mockStream as any);

            const result = await assembler.assemble();

            expect(result).toBe(path.join(artifactsRootDir, packageName, version, 'artifact.zip'));
            expect(fs.ensureDir).toHaveBeenCalledWith(path.join(artifactsRootDir, packageName, version));
            expect(mockChangelogProvider.generateChangelog).toHaveBeenCalledWith(mockSfpmPackage, projectDirectory);
            expect(fs.writeJSON).toHaveBeenCalledWith(
                expect.stringContaining('artifact_metadata.json'),
                { some: 'metadata' },
                { spaces: 4 }
            );
            expect(fs.writeJSON).toHaveBeenCalledWith(
                expect.stringContaining('manifest.json'),
                expect.objectContaining({ latest: version }),
                { spaces: 4 }
            );
            expect(fs.remove).toHaveBeenCalledWith('/tmp/staging');
            expect(fs.remove).toHaveBeenCalledWith(expect.stringContaining('source'));
        });

        it('should throw error and log if assembly fails', async () => {
            vi.mocked(fs.ensureDir).mockRejectedValue(new Error('Disk full'));

            await expect(assembler.assemble()).rejects.toThrow('Unable to create artifact: Disk full');
            expect(mockLogger.error).toHaveBeenCalledWith(expect.stringContaining('Failed to assemble artifact'));
        });
    });

    describe('prepareSource', () => {
        it('should copy staging directory and remove noise', async () => {
            vi.mocked(fs.pathExists).mockResolvedValue(true);
            vi.mocked(fs.remove).mockResolvedValue(undefined as any);
            vi.mocked(fs.copy).mockResolvedValue(undefined as any);

            const stagingSourceDir = await (assembler as any).prepareSource();

            expect(stagingSourceDir).toBe(path.join(artifactsRootDir, packageName, version, 'source'));
            expect(fs.remove).toHaveBeenCalledWith(path.join('/tmp/staging', '.sfpm'));
            expect(fs.remove).toHaveBeenCalledWith(path.join('/tmp/staging', '.sfdx'));
            expect(fs.copy).toHaveBeenCalledWith('/tmp/staging', stagingSourceDir);
            expect(fs.remove).toHaveBeenCalledWith('/tmp/staging');
        });

        it('should work when no staging directory is provided', async () => {
            mockSfpmPackage.stagingDirectory = undefined;
            const stagingSourceDir = await (assembler as any).prepareSource();
            expect(stagingSourceDir).toBe(path.join(artifactsRootDir, packageName, version, 'source'));
            expect(fs.copy).not.toHaveBeenCalled();
        });
    });

    describe('updateManifest', () => {
        it('should create new manifest if it does not exist', async () => {
            vi.mocked(fs.pathExists).mockResolvedValue(false);
            vi.mocked(fs.writeJSON).mockResolvedValue(undefined as any);

            await (assembler as any).updateManifest('/path/to/zip');

            expect(fs.writeJSON).toHaveBeenCalledWith(
                expect.stringContaining('manifest.json'),
                expect.objectContaining({
                    name: packageName,
                    latest: version,
                    versions: expect.objectContaining({
                        [version]: expect.any(Object)
                    })
                }),
                { spaces: 4 }
            );
        });

        it('should update existing manifest', async () => {
            vi.mocked(fs.pathExists).mockResolvedValue(true);
            const existingManifest = {
                name: packageName,
                latest: '0.0.0.1',
                versions: {
                    '0.0.0.1': { path: 'old/path', generatedAt: 123 }
                }
            };
            vi.mocked(fs.readJSON).mockResolvedValue(existingManifest);
            vi.mocked(fs.writeJSON).mockResolvedValue(undefined as any);

            await (assembler as any).updateManifest('/path/to/zip');

            const savedManifest = vi.mocked(fs.writeJSON).mock.calls[0][1];
            expect(savedManifest.latest).toBe(version);
            expect(savedManifest.versions[version]).toBeDefined();
            expect(savedManifest.versions['0.0.0.1']).toBeDefined();
        });
    });

    describe('updateLatestSymlink', () => {
        it('should create a junction/symlink', async () => {
            vi.mocked(fs.remove).mockResolvedValue(undefined as any);
            vi.mocked(fs.symlink).mockResolvedValue(undefined as any);

            await (assembler as any).updateLatestSymlink();

            expect(fs.remove).toHaveBeenCalledWith(expect.stringContaining('latest'));
            expect(fs.symlink).toHaveBeenCalledWith(
                path.join('.', version),
                expect.stringContaining('latest'),
                'junction'
            );
        });

        it('should fallback to latest.version file if symlink fails', async () => {
            vi.mocked(fs.remove).mockResolvedValue(undefined as any);
            vi.mocked(fs.symlink).mockRejectedValue(new Error('Symlink not supported'));
            vi.mocked(fs.writeFile).mockResolvedValue(undefined as any);

            await (assembler as any).updateLatestSymlink();

            expect(fs.writeFile).toHaveBeenCalledWith(
                expect.stringContaining('latest.version'),
                version
            );
            expect(mockLogger.warn).toHaveBeenCalledWith(expect.stringContaining('Symlink failed'));
        });
    });
});
