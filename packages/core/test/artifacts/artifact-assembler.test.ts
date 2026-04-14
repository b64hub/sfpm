import { describe, it, expect, vi, beforeEach, Mock } from 'vitest';
import path from 'path';
import * as fs from 'fs-extra';
import * as childProcess from 'child_process';
import { toVersionFormat } from '../../src/utils/version-utils.js';
import { PackageType } from '../../src/types/package.js';

// Create a mock repository instance that we can control
const mockRepository = {
    getVersionPath: vi.fn(),
    getArtifactPath: vi.fn(),
    getRelativeArtifactPath: vi.fn(),
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
        readJson: vi.fn(),
        rename: vi.fn(),
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

vi.mock('../../src/utils/version-utils.js', () => ({
    toVersionFormat: vi.fn()
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
        mockRepository.getArtifactPath.mockImplementation((pkg: string, ver: string) => `/project/artifacts/${pkg}/${ver}/artifact.tgz`);
        mockRepository.getRelativeArtifactPath.mockImplementation((pkg: string, ver: string) => `${pkg}/${ver}/artifact.tgz`);
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
            npmName: `@testorg/${packageName}`,
            version,
            type: PackageType.Unlocked,
            stagingDirectory: '/tmp/builds/test-build/package',
            packageDirectory: '/project/force-app',
            dependencies: [],
            metadata: {
                identity: { packageName, packageType: PackageType.Unlocked, versionNumber: version },
                source: { branch: 'main' },
                content: {},
                validation: {},
                orchestration: {},
            },
            projectDefinition: { packageAliases: {} },
            packageDefinition: { versionDescription: 'Test package' },
            toJson: vi.fn().mockResolvedValue({
                identity: { packageName, packageType: PackageType.Unlocked, versionNumber: version },
                source: { branch: 'main' },
                content: {},
                validation: {},
                orchestration: {},
            }),
        };

        mockLogger = {
            info: vi.fn(),
            error: vi.fn(),
            warn: vi.fn(),
            debug: vi.fn(),
        };

        mockOptions = {
            changelogProvider: {
                generateChangelog: vi.fn().mockResolvedValue({ commits: [] })
            },
            additionalKeywords: ['test'],
            author: 'Test Author',
            license: 'MIT'
        };

        vi.mocked(toVersionFormat).mockReturnValue(version);

        // Mock execSync for tar command
        vi.mocked(childProcess.execSync).mockReturnValue('');

        // Default: no existing package.json in staging directory
        vi.mocked(fs.pathExists as any).mockResolvedValue(false);

        // Mock fs.readJson to return package.json for tarball name generation
        vi.mocked(fs.readJson as any).mockResolvedValue({
            name: `@testorg/${packageName}`,
            version,
        });

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
        expect((assembler as any).options).toBeDefined();
    });

    describe('assemble', () => {
        it('should orchestrate the assembly process successfully', async () => {
            // Mock fs operations
            vi.mocked(fs.ensureDir).mockResolvedValue(undefined as any);
            vi.mocked(fs.pathExists).mockResolvedValue(true);
            vi.mocked(fs.remove).mockResolvedValue(undefined as any);
            vi.mocked(fs.writeJson).mockResolvedValue(undefined as any);
            vi.mocked(fs.move).mockResolvedValue(undefined as any);

            const result = await assembler.assemble();

            // Should return path to tgz file
            expect(result).toBe(`/project/artifacts/${packageName}/${version}/artifact.tgz`);
            
            // Should generate package.json in the package directory
            expect(fs.writeJson).toHaveBeenCalledWith(
                path.join('/tmp/builds/test-build/package', 'package.json'),
                expect.objectContaining({
                    name: `@testorg/${packageName}`,
                    version,
                    sfpm: expect.any(Object)
                }),
                { spaces: 2 }
            );
            
            // Should create tarball with tar from workspace dir
            expect(childProcess.execSync).toHaveBeenCalledWith(
                expect.stringContaining('tar -czf'),
                expect.objectContaining({ cwd: '/tmp/builds/test-build' })
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
            
            // Should cleanup workspace directory
            expect(fs.remove).toHaveBeenCalledWith('/tmp/builds/test-build');
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

            await (assembler as any).generatePackageJson('/tmp/staging');

            expect(fs.writeJson).toHaveBeenCalledWith(
                '/tmp/staging/package.json',
                expect.objectContaining({
                    name: `@testorg/${packageName}`,
                    version,
                    description: 'Test package',
                    keywords: expect.arrayContaining(['sfpm', 'salesforce', 'test']),
                    license: 'MIT',
                    author: 'Test Author',
                    sfpm: expect.any(Object)
                }),
                { spaces: 2 }
            );

            // Verify sfpm metadata was retrieved from package
            expect(mockSfpmPackage.toJson).toHaveBeenCalled();
        });

        it('should include managedDependencies for pinned dependencies', async () => {
            // Recreate assembler with managed dependencies in options
            assembler = new ArtifactAssembler(
                mockSfpmPackage,
                projectDirectory,
                {
                    ...mockOptions,
                    managedDependencies: { 'Nebula Logger@4.16.0': '04taA000005CtsHQAS' },
                },
                mockLogger,
            );
            vi.mocked(fs.writeJson).mockResolvedValue(undefined as any);

            await (assembler as any).generatePackageJson('/tmp/staging');

            expect(fs.writeJson).toHaveBeenCalledWith(
                '/tmp/staging/package.json',
                expect.objectContaining({
                    managedDependencies: {
                        'Nebula Logger@4.16.0': '04taA000005CtsHQAS'
                    }
                }),
                { spaces: 2 }
            );
        });

        it('should filter empty values from sfpm metadata', async () => {
            mockSfpmPackage.toJson.mockResolvedValue({
                identity: { packageName, packageType: PackageType.Unlocked },
                source: {},
                content: { triggers: [], flows: [], profiles: [], fields: { all: [] } },
                validation: {},
                orchestration: {},
            });
            vi.mocked(fs.writeJson).mockResolvedValue(undefined as any);

            await (assembler as any).generatePackageJson('/tmp/staging');

            const writtenJson = vi.mocked(fs.writeJson).mock.calls[0][1] as any;
            const sfpm = writtenJson.sfpm;

            // Empty arrays and objects should be removed
            expect(sfpm.content?.triggers).toBeUndefined();
            expect(sfpm.content?.flows).toBeUndefined();
            expect(sfpm.content?.profiles).toBeUndefined();
            expect(sfpm.content?.fields).toBeUndefined();
            expect(sfpm.source).toBeUndefined();
            expect(sfpm.validation).toBeUndefined();
            expect(sfpm.orchestration).toBeUndefined();
        });
    });

    describe('createTarball', () => {
        it('should create tarball and return filename', async () => {
            vi.mocked(childProcess.execSync).mockReturnValue('');
            vi.mocked(fs.readJson as any).mockResolvedValue({
                name: `@testorg/${packageName}`,
                version,
            });

            const result = await (assembler as any).createTarball('/tmp/workspace');

            expect(result).toBe(`testorg-${packageName}-${version}.tgz`);
            expect(childProcess.execSync).toHaveBeenCalledWith(
                expect.stringContaining('tar -czf'),
                expect.objectContaining({
                    cwd: '/tmp/workspace',
                    encoding: 'utf8'
                })
            );
        });

        it('should throw ArtifactError if tar fails', async () => {
            vi.mocked(fs.readJson as any).mockResolvedValue({
                name: `@testorg/${packageName}`,
                version,
            });
            vi.mocked(childProcess.execSync).mockImplementation(() => {
                throw new Error('tar failed');
            });

            await expect((assembler as any).createTarball('/tmp/workspace')).rejects.toThrow('Failed to create tarball');
        });
    });

    describe('moveTarball', () => {
        it('should move tarball to version directory', async () => {
            vi.mocked(fs.ensureDir).mockResolvedValue(undefined as any);
            vi.mocked(fs.move).mockResolvedValue(undefined as any);

            const result = await (assembler as any).moveTarball('/tmp/workspace', 'test-1.0.0-1.tgz');

            expect(fs.ensureDir).toHaveBeenCalledWith(`/project/artifacts/${packageName}/${version}`);
            expect(fs.move).toHaveBeenCalledWith(
                '/tmp/workspace/test-1.0.0-1.tgz',
                `/project/artifacts/${packageName}/${version}/artifact.tgz`,
                { overwrite: true }
            );
            expect(result).toBe(`/project/artifacts/${packageName}/${version}/artifact.tgz`);
        });
    });
});
