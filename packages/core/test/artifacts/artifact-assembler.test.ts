import { describe, it, expect, vi, beforeEach, Mock } from 'vitest';
import path from 'path';
import * as fs from 'fs-extra';
import * as childProcess from 'child_process';
import { VersionManager } from '../../src/project/version-manager.js';
import { PackageType } from '../../src/types/package.js';

// Create a mock repository instance that we can control
const mockRepository = {
    getVersionPath: vi.fn(),
    getArtifactZipPath: vi.fn(),
    getArtifactTgzPath: vi.fn(),
    getManifest: vi.fn(),
    getManifestSync: vi.fn(),
    saveManifest: vi.fn(),
    updateLatestSymlink: vi.fn(),
    calculateFileHash: vi.fn(),
    finalizeArtifact: vi.fn(),
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

vi.mock('child_process', () => ({
    execSync: vi.fn()
}));

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
import ArtifactAssembler, { ArtifactAssemblerOptions } from '../../src/artifacts/artifact-assembler.js';

describe('ArtifactAssembler', () => {
    let mockSfpmPackage: any;
    let mockLogger: any;
    let mockOptions: ArtifactAssemblerOptions;
    let assembler: ArtifactAssembler;

    const projectDirectory = '/project';
    const packageName = 'my-package';
    const version = '1.0.0-1';

    beforeEach(() => {
        vi.clearAllMocks();

        // Configure mock repository for this test
        mockRepository.getVersionPath.mockImplementation((pkg: string, ver: string) => `/project/artifacts/${pkg}/${ver}`);
        mockRepository.getArtifactTgzPath.mockImplementation((pkg: string, ver: string) => `/project/artifacts/${pkg}/${ver}/artifact.tgz`);
        mockRepository.getArtifactZipPath.mockImplementation((pkg: string, ver: string) => `/project/artifacts/${pkg}/${ver}/artifact.zip`);
        mockRepository.getManifest.mockResolvedValue(undefined);
        mockRepository.getManifestSync.mockReturnValue(undefined);
        mockRepository.saveManifest.mockResolvedValue(undefined);
        mockRepository.updateLatestSymlink.mockResolvedValue(undefined);
        mockRepository.calculateFileHash.mockResolvedValue('mockhash123');
        mockRepository.finalizeArtifact.mockResolvedValue(undefined);

        mockSfpmPackage = {
            packageName,
            version,
            type: PackageType.Unlocked,
            stagingDirectory: '/tmp/staging',
            packageDirectory: '/project/force-app',
            dependencies: [],
            packageDefinition: { versionDescription: 'Test package' },
            toSfpmMetadata: vi.fn().mockReturnValue({
                packageType: PackageType.Unlocked,
                packageName,
                versionNumber: version,
                generatedAt: Date.now(),
                source: { branch: 'main' }
            })
        };

        mockLogger = {
            info: vi.fn(),
            error: vi.fn(),
            warn: vi.fn(),
            debug: vi.fn(),
        };

        mockOptions = {
            npmScope: '@testorg',
            changelogProvider: {
                generateChangelog: vi.fn().mockResolvedValue({ commits: [] })
            },
            additionalKeywords: ['test'],
            author: 'Test Author',
            license: 'MIT'
        };

        vi.mocked(VersionManager.normalizeVersion).mockReturnValue(version);

        // Mock execSync to return tarball filename from npm pack
        vi.mocked(childProcess.execSync).mockReturnValue(`testorg-${packageName}-${version}.tgz\n`);

        assembler = new ArtifactAssembler(
            mockSfpmPackage,
            projectDirectory,
            mockOptions,
            mockLogger,
        );
    });

    it('should initialize with correct paths', () => {
        expect((assembler as any).versionDirectory).toBe(`/project/artifacts/${packageName}/${version}`);
        expect((assembler as any).repository).toBeDefined();
        expect((assembler as any).options.npmScope).toBe('@testorg');
    });

    describe('assemble', () => {
        it('should orchestrate the npm pack assembly process successfully', async () => {
            // Mock fs operations
            vi.mocked(fs.ensureDir).mockResolvedValue(undefined as any);
            vi.mocked(fs.pathExists).mockResolvedValue(true);
            vi.mocked(fs.remove).mockResolvedValue(undefined as any);
            vi.mocked(fs.writeJson).mockResolvedValue(undefined as any);
            vi.mocked(fs.writeFile).mockResolvedValue(undefined as any);
            vi.mocked(fs.move).mockResolvedValue(undefined as any);

            const result = await assembler.assemble();

            // Should return path to tgz file
            expect(result).toBe(`/project/artifacts/${packageName}/${version}/artifact.tgz`);
            
            // Should generate package.json
            expect(fs.writeJson).toHaveBeenCalledWith(
                path.join('/tmp/staging', 'package.json'),
                expect.objectContaining({
                    name: `@testorg/${packageName}`,
                    version,
                    sfpm: expect.any(Object)
                }),
                { spaces: 2 }
            );
            
            // Should run npm pack
            expect(childProcess.execSync).toHaveBeenCalledWith(
                'npm pack',
                expect.objectContaining({ cwd: '/tmp/staging' })
            );
            
            // Should finalize artifact (update manifest and symlink)
            expect(mockRepository.finalizeArtifact).toHaveBeenCalledWith(
                packageName,
                version,
                expect.objectContaining({
                    path: `${packageName}/${version}/artifact.tgz`,
                    sourceHash: expect.any(String),
                    artifactHash: 'mockhash123'
                })
            );
            
            // Should cleanup staging
            expect(fs.remove).toHaveBeenCalledWith('/tmp/staging');
        });

        it('should throw ArtifactError if no staging directory is available', async () => {
            mockSfpmPackage.stagingDirectory = undefined;
            
            assembler = new ArtifactAssembler(
                mockSfpmPackage,
                projectDirectory,
                mockOptions,
                mockLogger,
            );

            await expect(assembler.assemble()).rejects.toThrow('Failed to assemble artifact');
        });

        it('should throw ArtifactError and log if assembly fails', async () => {
            vi.mocked(fs.pathExists).mockRejectedValue(new Error('Disk full'));

            await expect(assembler.assemble()).rejects.toThrow('Failed to assemble artifact');
            expect(mockLogger.error).toHaveBeenCalledWith(expect.stringContaining('Failed to assemble artifact'));
        });
    });

    describe('generatePackageJson', () => {
        it('should generate package.json with sfpm metadata', async () => {
            vi.mocked(fs.writeJson).mockResolvedValue(undefined as any);

            await (assembler as any).generatePackageJson('/tmp/staging', 'sourcehash123');

            expect(fs.writeJson).toHaveBeenCalledWith(
                '/tmp/staging/package.json',
                expect.objectContaining({
                    name: `@testorg/${packageName}`,
                    version,
                    description: 'Test package',
                    main: 'index.js',
                    keywords: expect.arrayContaining(['sfpm', 'salesforce', 'test']),
                    license: 'MIT',
                    author: 'Test Author',
                    sfpm: expect.any(Object)
                }),
                { spaces: 2 }
            );

            // Verify sfpm metadata was retrieved from package
            expect(mockSfpmPackage.toSfpmMetadata).toHaveBeenCalledWith('sourcehash123');
        });

        it('should include optionalDependencies when package has dependencies', async () => {
            mockSfpmPackage.dependencies = [
                { package: 'dep-package', versionNumber: '1.0.0.1' }
            ];
            vi.mocked(fs.writeJson).mockResolvedValue(undefined as any);

            await (assembler as any).generatePackageJson('/tmp/staging', 'sourcehash123');

            expect(fs.writeJson).toHaveBeenCalledWith(
                '/tmp/staging/package.json',
                expect.objectContaining({
                    optionalDependencies: {
                        '@testorg/dep-package': '^1.0.0'
                    }
                }),
                { spaces: 2 }
            );
        });
    });

    describe('runNpmPack', () => {
        it('should execute npm pack and return tarball filename', async () => {
            vi.mocked(childProcess.execSync).mockReturnValue(`testorg-${packageName}-${version}.tgz\n`);

            const result = await (assembler as any).runNpmPack('/tmp/staging');

            expect(result).toBe(`testorg-${packageName}-${version}.tgz`);
            expect(childProcess.execSync).toHaveBeenCalledWith(
                'npm pack',
                expect.objectContaining({
                    cwd: '/tmp/staging',
                    encoding: 'utf-8'
                })
            );
        });

        it('should throw ArtifactError if npm pack fails', async () => {
            vi.mocked(childProcess.execSync).mockImplementation(() => {
                throw new Error('npm pack failed');
            });

            await expect((assembler as any).runNpmPack('/tmp/staging')).rejects.toThrow('npm pack failed');
        });
    });

    describe('moveTarball', () => {
        it('should move tarball to version directory', async () => {
            vi.mocked(fs.ensureDir).mockResolvedValue(undefined as any);
            vi.mocked(fs.move).mockResolvedValue(undefined as any);

            const result = await (assembler as any).moveTarball('/tmp/staging', 'test-1.0.0-1.tgz');

            expect(fs.ensureDir).toHaveBeenCalledWith(`/project/artifacts/${packageName}/${version}`);
            expect(fs.move).toHaveBeenCalledWith(
                '/tmp/staging/test-1.0.0-1.tgz',
                `/project/artifacts/${packageName}/${version}/artifact.tgz`,
                { overwrite: true }
            );
            expect(result).toBe(`/project/artifacts/${packageName}/${version}/artifact.tgz`);
        });
    });
});
