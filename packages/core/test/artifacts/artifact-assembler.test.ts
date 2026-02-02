import { describe, it, expect, vi, beforeEach, Mock } from 'vitest';
import path from 'path';
import * as fs from 'fs-extra';
import { VersionManager } from '../../src/project/version-manager.js';

// Create a mock repository instance that we can control
const mockRepository = {
    getVersionPath: vi.fn(),
    getArtifactZipPath: vi.fn(),
    getManifest: vi.fn(),
    getManifestSync: vi.fn(),
    saveManifest: vi.fn(),
    updateLatestSymlink: vi.fn(),
    calculateFileHash: vi.fn(),
    createArtifactZip: vi.fn(),
};

vi.mock('fs-extra', () => {
    const mocks = {
        ensureDir: vi.fn(),
        pathExists: vi.fn<(path: string) => Promise<boolean>>(),
        remove: vi.fn(),
        copy: vi.fn(),
        writeJSON: vi.fn(),
        writeJson: vi.fn(),
        readJSON: vi.fn(),
        symlink: vi.fn(),
        writeFile: vi.fn(),
        createWriteStream: vi.fn(),
        createReadStream: vi.fn(),
        existsSync: vi.fn(),
        readJsonSync: vi.fn(),
        move: vi.fn(),
    };
    return {
        ...mocks,
        default: mocks
    };
});

// Mock artifact-repository with our controlled mock
vi.mock('../../src/artifacts/artifact-repository.js', () => {
    return {
        ArtifactRepository: function() { return mockRepository; },
    };
});

vi.mock('../../src/project/version-manager.js', () => ({
    VersionManager: {
        normalizeVersion: vi.fn()
    }
}));

// Import after mocks are set up
import ArtifactAssembler from '../../src/artifacts/artifact-assembler.js';

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
        vi.clearAllMocks();

        // Configure mock repository for this test (after clear, need to set implementations)
        mockRepository.getVersionPath.mockImplementation((pkg: string, ver: string) => `/artifacts/${pkg}/${ver}`);
        mockRepository.getArtifactZipPath.mockImplementation((pkg: string, ver: string) => `/artifacts/${pkg}/${ver}/artifact.zip`);
        mockRepository.getManifest.mockResolvedValue(undefined);
        mockRepository.getManifestSync.mockReturnValue(undefined);
        mockRepository.saveManifest.mockResolvedValue(undefined);
        mockRepository.updateLatestSymlink.mockResolvedValue(undefined);
        mockRepository.calculateFileHash.mockResolvedValue('mockhash123');
        mockRepository.createArtifactZip.mockResolvedValue(undefined);

        mockSfpmPackage = {
            packageName,
            version,
            stagingDirectory: '/tmp/staging',
            toPackageMetadata: vi.fn().mockResolvedValue({ some: 'metadata' })
        };

        mockLogger = {
            info: vi.fn(),
            error: vi.fn(),
            warn: vi.fn(),
            debug: vi.fn(),
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
        // Mock returns /artifacts/<pkg>/<version>
        expect((assembler as any).versionDirectory).toBe(`/artifacts/${packageName}/${version}`);
        expect((assembler as any).repository).toBeDefined();
    });

    describe('assemble', () => {
        it('should orchestrate the assembly process successfully', async () => {
            // Mock sub-methods or their dependencies
            vi.mocked(fs.ensureDir).mockResolvedValue(undefined as any);
            vi.mocked(fs.pathExists).mockResolvedValue(true);
            vi.mocked(fs.remove).mockResolvedValue(undefined as any);
            vi.mocked(fs.copy).mockResolvedValue(undefined as any);
            vi.mocked(fs.writeJSON).mockResolvedValue(undefined as any);
            vi.mocked(fs.writeJson).mockResolvedValue(undefined as any);

            const result = await assembler.assemble();

            // Mock returns /artifacts/<pkg>/<version>/artifact.zip
            expect(result).toBe(`/artifacts/${packageName}/${version}/artifact.zip`);
            expect(fs.ensureDir).toHaveBeenCalledWith(`/artifacts/${packageName}/${version}`);
            expect(mockChangelogProvider.generateChangelog).toHaveBeenCalledWith(mockSfpmPackage, projectDirectory);
            expect(fs.writeJson).toHaveBeenCalledWith(
                expect.stringContaining('artifact_metadata.json'),
                { some: 'metadata' },
                { spaces: 4 }
            );
            // Repository handles manifest and symlink
            const repo = (assembler as any).repository;
            expect(repo.saveManifest).toHaveBeenCalled();
            expect(repo.updateLatestSymlink).toHaveBeenCalledWith(packageName, version);
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
            vi.mocked(fs.ensureDir).mockResolvedValue(undefined as any);
            vi.mocked(fs.pathExists).mockResolvedValue(true);
            vi.mocked(fs.remove).mockResolvedValue(undefined as any);
            vi.mocked(fs.copy).mockResolvedValue(undefined as any);

            const stagingSourceDir = await (assembler as any).prepareSource();

            // Mock repo returns /artifacts/<pkg>/<version>
            expect(stagingSourceDir).toBe(`/artifacts/${packageName}/${version}/source`);
            expect(fs.remove).toHaveBeenCalledWith(path.join('/tmp/staging', '.sfpm'));
            expect(fs.remove).toHaveBeenCalledWith(path.join('/tmp/staging', '.sfdx'));
            expect(fs.copy).toHaveBeenCalledWith('/tmp/staging', stagingSourceDir);
            expect(fs.remove).toHaveBeenCalledWith('/tmp/staging');
        });

        it('should work when no staging directory is provided', async () => {
            vi.mocked(fs.ensureDir).mockResolvedValue(undefined as any);
            mockSfpmPackage.stagingDirectory = undefined;
            
            // Need to recreate assembler with the modified package
            assembler = new ArtifactAssembler(
                mockSfpmPackage,
                projectDirectory,
                artifactsRootDir,
                mockLogger,
                mockChangelogProvider
            );
            
            const stagingSourceDir = await (assembler as any).prepareSource();
            expect(stagingSourceDir).toBe(`/artifacts/${packageName}/${version}/source`);
            expect(fs.copy).not.toHaveBeenCalled();
        });
    });

    describe('updateManifest', () => {
        it('should create new manifest if it does not exist', async () => {
            // The repository mock handles this now
            await (assembler as any).updateManifest('/path/to/zip', 'sourcehash', 'artifacthash');

            const repo = (assembler as any).repository;
            expect(repo.saveManifest).toHaveBeenCalledWith(
                packageName,
                expect.objectContaining({
                    name: packageName,
                    latest: version,
                    versions: expect.objectContaining({
                        [version]: expect.any(Object)
                    })
                })
            );
        });

        it('should update existing manifest', async () => {
            const existingManifest = {
                name: packageName,
                latest: '0.0.0.1',
                versions: {
                    '0.0.0.1': { path: 'old/path', generatedAt: 123 }
                }
            };
            const repo = (assembler as any).repository;
            repo.getManifest.mockResolvedValue(existingManifest);

            await (assembler as any).updateManifest('/path/to/zip', 'sourcehash', 'artifacthash');

            expect(repo.saveManifest).toHaveBeenCalled();
            const savedManifest = repo.saveManifest.mock.calls[0][1];
            expect(savedManifest.latest).toBe(version);
            expect(savedManifest.versions[version]).toBeDefined();
            expect(savedManifest.versions['0.0.0.1']).toBeDefined();
        });
    });
});
