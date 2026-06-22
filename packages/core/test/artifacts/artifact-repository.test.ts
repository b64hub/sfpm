import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import path from 'path';
import fs from 'fs-extra';
import { ArtifactRepository } from '../../src/artifacts/artifact-repository.js';

// Mock package.json content (flat sfpm metadata structure)
const mockDistPackageJson = {
    name: '@testorg/test-package',
    version: '1.0.0-1',
    sfpm: {
        packageName: '@testorg/test-package',
        packageType: 'unlocked',
        versionNumber: '1.0.0-1',
        packageId: '0Ho1234567890',
        packageVersionId: '04t1234567890',
        sourceHash: 'abc123',
        orchestration: {},
        source: {
            sourceHash: 'abc123',
        },
    }
};

// Mock external dependencies
vi.mock('fs-extra');

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

    beforeEach(() => {
        vi.clearAllMocks();
        repository = new ArtifactRepository(packageWorkspacePath, mockLogger);
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    describe('path resolution', () => {
        it('should return correct dist dir', () => {
            expect(repository.getDistDir()).toBe(
                path.join(packageWorkspacePath, 'dist')
            );
        });

        it('should return correct package workspace path', () => {
            expect(repository.getPackageWorkspacePath()).toBe(packageWorkspacePath);
        });

        it('should return dist dir for deprecated getPackageContentDir', () => {
            expect(repository.getPackageContentDir()).toBe(
                path.join(packageWorkspacePath, 'dist')
            );
        });

        it('should return dist dir for deprecated getArtifactsDir', () => {
            expect(repository.getArtifactsDir()).toBe(
                path.join(packageWorkspacePath, 'dist')
            );
        });
    });

    describe('existence checks', () => {
        it('should return true if dist/package.json exists', () => {
            vi.mocked(fs.existsSync).mockReturnValue(true);
            expect(repository.hasArtifact()).toBe(true);
            expect(fs.existsSync).toHaveBeenCalledWith(
                path.join(packageWorkspacePath, 'dist', 'package.json')
            );
        });

        it('should return false if dist/package.json does not exist', () => {
            vi.mocked(fs.existsSync).mockReturnValue(false);
            expect(repository.hasArtifact()).toBe(false);
        });
    });

    describe('checkSourceHash', () => {
        it('should return match when source hash matches dist/package.json', async () => {
            vi.mocked(fs.pathExists).mockResolvedValue(true);
            vi.mocked(fs.readJson).mockResolvedValue(mockDistPackageJson);

            const result = await repository.checkSourceHash('abc123');

            expect(result).toEqual({
                artifactPath: path.join(packageWorkspacePath, 'dist'),
                latestVersion: '1.0.0-1',
            });
        });

        it('should return undefined when source hash does not match', async () => {
            vi.mocked(fs.pathExists).mockResolvedValue(true);
            vi.mocked(fs.readJson).mockResolvedValue(mockDistPackageJson);

            const result = await repository.checkSourceHash('different-hash');
            expect(result).toBeUndefined();
        });

        it('should return undefined when no previous build exists', async () => {
            vi.mocked(fs.pathExists).mockResolvedValue(false);

            const result = await repository.checkSourceHash('abc123');
            expect(result).toBeUndefined();
        });

        it('should return undefined when package.json has no sourceHash', async () => {
            vi.mocked(fs.pathExists).mockResolvedValue(true);
            vi.mocked(fs.readJson).mockResolvedValue({
                name: '@testorg/test-package',
                version: '1.0.0',
                sfpm: { packageType: 'source' },
            });

            const result = await repository.checkSourceHash('abc123');
            expect(result).toBeUndefined();
        });
    });

    describe('metadata reading', () => {
        it('should extract packageVersionId from dist/package.json', () => {
            vi.mocked(fs.existsSync).mockReturnValue(true);
            vi.mocked(fs.readJsonSync).mockReturnValue(mockDistPackageJson);

            expect(repository.getPackageVersionId()).toBe('04t1234567890');
        });

        it('should return undefined when no dist/package.json exists', () => {
            vi.mocked(fs.existsSync).mockReturnValue(false);

            expect(repository.getPackageVersionId()).toBeUndefined();
        });

        it('should extract sourceHash from dist/package.json', () => {
            vi.mocked(fs.existsSync).mockReturnValue(true);
            vi.mocked(fs.readJsonSync).mockReturnValue(mockDistPackageJson);

            expect(repository.getSourceHash()).toBe('abc123');
        });

        it('should extract version from dist/package.json', () => {
            vi.mocked(fs.existsSync).mockReturnValue(true);
            vi.mocked(fs.readJsonSync).mockReturnValue(mockDistPackageJson);

            expect(repository.getVersion()).toBe('1.0.0-1');
        });

        it('should get metadata from dist/package.json', () => {
            vi.mocked(fs.existsSync).mockReturnValue(true);
            vi.mocked(fs.readJsonSync).mockReturnValue(mockDistPackageJson);

            const metadata = repository.getMetadata();
            expect(metadata).toBeDefined();
            expect(metadata?.packageVersionId).toBe('04t1234567890');
        });

        it('should return undefined metadata when no dist/package.json exists', () => {
            vi.mocked(fs.existsSync).mockReturnValue(false);

            const metadata = repository.getMetadata();
            expect(metadata).toBeUndefined();
        });
    });

    describe('clean', () => {
        it('should remove the dist directory', async () => {
            vi.mocked(fs.remove).mockResolvedValue(undefined as any);

            await repository.clean();

            expect(fs.remove).toHaveBeenCalledWith(
                path.join(packageWorkspacePath, 'dist')
            );
        });
    });

    describe('readDistPackageJson', () => {
        it('should read dist/package.json asynchronously', async () => {
            vi.mocked(fs.pathExists).mockResolvedValue(true);
            vi.mocked(fs.readJson).mockResolvedValue(mockDistPackageJson);

            const result = await repository.readDistPackageJson();
            expect(result).toEqual(mockDistPackageJson);
            expect(fs.readJson).toHaveBeenCalledWith(
                path.join(packageWorkspacePath, 'dist', 'package.json')
            );
        });

        it('should return undefined if dist/package.json does not exist', async () => {
            vi.mocked(fs.pathExists).mockResolvedValue(false);

            const result = await repository.readDistPackageJson();
            expect(result).toBeUndefined();
        });

        it('should return undefined and warn on read error', async () => {
            vi.mocked(fs.pathExists).mockResolvedValue(true);
            vi.mocked(fs.readJson).mockRejectedValue(new Error('parse error'));

            const result = await repository.readDistPackageJson();
            expect(result).toBeUndefined();
            expect(mockLogger.warn).toHaveBeenCalledWith(
                expect.stringContaining('Failed to read dist/package.json')
            );
        });
    });
});
