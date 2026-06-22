import { describe, it, expect, vi, beforeEach, Mock } from 'vitest';
import path from 'path';
import * as fs from 'fs-extra';
import * as childProcess from 'child_process';
import { toVersionFormat } from '../../src/utils/version-utils.js';
import { PackageType } from '../../src/types/package.js';

// Create a mock repository instance (no longer used by assembler, but kept for mock setup)
const mockRepository = {
    getDistDir: vi.fn(),
    getPackageWorkspacePath: vi.fn(),
    readDistPackageJson: vi.fn(),
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

// Mock workspace-path to return a predictable path
vi.mock('../../src/utils/workspace-path.js', () => ({
    resolvePackageWorkspacePath: vi.fn().mockReturnValue('/project/packages/my-package'),
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
    const scopedName = `@testorg/${packageName}`;
    const version = '1.0.0-1';

    beforeEach(() => {
        vi.clearAllMocks();

        // Configure mock repository for this test
        mockRepository.getDistDir.mockReturnValue('/project/packages/my-package/dist');
        mockRepository.getPackageWorkspacePath.mockReturnValue('/project/packages/my-package');
        mockRepository.readDistPackageJson.mockResolvedValue(undefined);

        mockSfpmPackage = {
            packageName,
            name: `@testorg/${packageName}`,
            version,
            type: PackageType.Unlocked,
            workingDirectory: '/tmp/builds/test-build/package',
            packageDirectory: '/project/force-app',
            dependencies: [],
            orchestration: {},
            source: { branch: 'main' },
            scope: '@testorg',
            projectDefinition: { packageAliases: {} },
            packageDefinition: { path: 'packages/my-package/force-app', versionDescription: 'Test package' },
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

    it('should initialize correctly', () => {
        expect((assembler as any).options).toBeDefined();
    });

    describe('assemble', () => {
        it('should orchestrate the assembly process successfully', async () => {
            // Mock fs operations
            vi.mocked(fs.ensureDir).mockResolvedValue(undefined as any);
            vi.mocked(fs.pathExists as any).mockImplementation(async (p: string) => {
                // Workspace package.json discovery + general staging checks
                if (p === '/project/packages/my-package/package.json') return true;
                return true;
            });
            vi.mocked(fs.readJson as any).mockImplementation(async (p: string) => {
                if (p === '/project/packages/my-package/package.json') {
                    return {
                        name: `@testorg/${packageName}`,
                        version: '1.0.0',
                        license: 'MIT',
                        sfpm: { packageType: 'unlocked', path: 'force-app' },
                    };
                }

                // Default: tarball name generation reads package.json
                return { name: `@testorg/${packageName}`, version };
            });
            vi.mocked(fs.remove).mockResolvedValue(undefined as any);
            vi.mocked(fs.writeJson).mockResolvedValue(undefined as any);
            vi.mocked(fs.move).mockResolvedValue(undefined as any);

            const result = await assembler.assemble();

            // Should return the package content directory
            expect(result).toBe('/tmp/builds/test-build/package');
            
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
            
            // Should NOT call finalizeArtifact (manifest eliminated)
            // Should NOT create tarball or cleanup
            expect(childProcess.execSync).not.toHaveBeenCalled();
            expect(fs.remove).not.toHaveBeenCalledWith('/tmp/builds/test-build');
        });

        it('should throw ArtifactError if no staging directory is available', async () => {
            mockSfpmPackage.workingDirectory = undefined;
            
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
        const workspacePkgJson = {
            name: `@testorg/${packageName}`,
            version: '1.0.0',
            author: 'Test Author',
            license: 'MIT',
            description: 'Test package',
            sfpm: {
                packageType: 'unlocked',
                path: 'force-app',
            },
        };

        it('should generate package.json with workspace base and sfpm metadata', async () => {
            vi.mocked(fs.writeJson).mockResolvedValue(undefined as any);
            vi.mocked(fs.pathExists as any).mockImplementation(async (p: string) =>
                p === '/project/packages/my-package/package.json');
            vi.mocked(fs.readJson as any).mockImplementation(async (p: string) => {
                if (p === '/project/packages/my-package/package.json') return workspacePkgJson;
                return { name: `@testorg/${packageName}`, version };
            });

            await (assembler as any).generatePackageJson('/tmp/staging');

            expect(fs.writeJson).toHaveBeenCalledWith(
                '/tmp/staging/package.json',
                expect.objectContaining({
                    name: `@testorg/${packageName}`,
                    author: 'Test Author',
                    license: 'MIT',
                    sfpm: expect.any(Object)
                }),
                { spaces: 2 }
            );

            // packageName is no longer in sfpm — derived from top-level name
            const writtenJson = vi.mocked(fs.writeJson).mock.calls[0][1] as any;
            expect(writtenJson.sfpm.packageType).toBe(PackageType.Unlocked);
            expect(writtenJson.name).toContain(packageName);
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
            vi.mocked(fs.pathExists as any).mockImplementation(async (p: string) =>
                p === '/project/packages/my-package/package.json');
            vi.mocked(fs.readJson as any).mockImplementation(async (p: string) => {
                if (p === '/project/packages/my-package/package.json') return workspacePkgJson;
                return { name: `@testorg/${packageName}`, version };
            });

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
            // Set empty values on the package to verify they get stripped
            mockSfpmPackage.source = {};
            mockSfpmPackage.orchestration = {};
            vi.mocked(fs.writeJson).mockResolvedValue(undefined as any);
            vi.mocked(fs.pathExists as any).mockImplementation(async (p: string) =>
                p === '/project/packages/my-package/package.json');
            vi.mocked(fs.readJson as any).mockImplementation(async (p: string) => {
                if (p === '/project/packages/my-package/package.json') return workspacePkgJson;
                return { name: `@testorg/${packageName}`, version };
            });

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

    describe('createTarball (removed)', () => {
        it('tarball creation is deferred to publish — method no longer exists', () => {
            expect((assembler as any).createTarball).toBeUndefined();
        });
    });

    describe('moveTarball (removed)', () => {
        it('tarball operations are deferred to publish — method no longer exists', () => {
            expect((assembler as any).moveTarball).toBeUndefined();
        });
    });
});
