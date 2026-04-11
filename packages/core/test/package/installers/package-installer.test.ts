import { describe, it, expect, beforeEach, vi } from 'vitest';
import PackageInstaller from '../../../src/package/package-installer.js';
import { InstallerRegistry } from '../../../src/package/installers/installer-registry.js';
import { PackageFactory } from '../../../src/package/sfpm-package.js';
import { PackageType } from '../../../src/types/package.js';

// Mocks
vi.mock('../../../src/project/project-config.js');
vi.mock('../../../src/package/sfpm-package.js');
vi.mock('@salesforce/core', () => ({
    Org: {
        create: vi.fn().mockResolvedValue({
            getUsername: vi.fn().mockReturnValue('test@org.com'),
        }),
    },
}));
// Mock the ArtifactService singleton
vi.mock('../../../src/artifacts/artifact-service.js', () => ({
    ArtifactService: {
        getInstance: vi.fn().mockReturnValue({
            setOrg: vi.fn().mockReturnThis(),
            setLogger: vi.fn().mockReturnThis(),
            resolveInstallTarget: vi.fn().mockResolvedValue({
                needsInstall: true,
                installReason: 'New installation',
                resolved: {
                    source: 'local',
                    version: '1.0.0',
                    versionEntry: { sourceHash: 'abc123' },
                },
            }),
            upsertArtifact: vi.fn().mockResolvedValue(undefined),
        }),
    },
}));

describe('PackageInstaller', () => {
    let installer: PackageInstaller;
    let mockProjectConfig: any;
    let mockLogger: any;
    let mockPackageFactory: any;
    let mockPackageFactoryInstance: any;
    let mockPackage: any;
    let mockInstallerInstance: any;
    let mockInstallerConstructor: any;

    beforeEach(() => {
        mockLogger = {
            info: vi.fn(),
            error: vi.fn(),
        };

        mockProjectConfig = {
            projectPath: '/test/project',
        };

        mockPackage = {
            name: 'test-package',
            npmName: '@test/test-package',
            packageName: 'test-package',
            type: PackageType.Unlocked,
            projectDirectory: '/test/project',
            version: '1.0.0',
            sourceHash: 'abc123',
        };

        mockInstallerInstance = {
            connect: vi.fn().mockResolvedValue(undefined),
            exec: vi.fn().mockResolvedValue({}),
        };

        // Create a proper constructor mock that returns the instance
        mockInstallerConstructor = vi.fn(function(this: any) {
            return mockInstallerInstance;
        }) as any;

        // Create package factory instance that will be returned from constructor
        mockPackageFactoryInstance = {
            createFromName: vi.fn().mockReturnValue(mockPackage),
            isManagedPackage: vi.fn().mockReturnValue(false),
            createManagedRef: vi.fn().mockReturnValue(null),
        };

        // Create a proper constructor mock
        mockPackageFactory = vi.fn(function(this: any, projectConfig: any) {
            return mockPackageFactoryInstance;
        }) as any;

        // Replace the mock before instantiation
        vi.mocked(PackageFactory).mockImplementation(mockPackageFactory);

        // Mock registry
        vi.spyOn(InstallerRegistry, 'getInstaller').mockReturnValue(mockInstallerConstructor);

        installer = new PackageInstaller(
            mockProjectConfig,
            { targetOrg: 'testOrg', installationKey: 'test-key' },
            mockLogger
        );

        vi.clearAllMocks();
    });

    describe('installPackage', () => {
        it('should successfully install a package', async () => {
            await installer.installPackage('test-package');

            expect(PackageFactory).toHaveBeenCalledWith(mockProjectConfig);
            expect(mockPackageFactoryInstance.createFromName).toHaveBeenCalledWith('test-package');
            expect(InstallerRegistry.getInstaller).toHaveBeenCalledWith(PackageType.Unlocked);
            expect(mockInstallerInstance.connect).toHaveBeenCalledWith('testOrg');
            expect(mockInstallerInstance.exec).toHaveBeenCalled();
            expect(mockLogger.info).toHaveBeenCalledWith('Successfully installed test-package@1.0.0');
        });

        it('should emit install:start event', async () => {
            const startHandler = vi.fn();
            installer.on('install:start', startHandler);

            await installer.installPackage('test-package');

            expect(startHandler).toHaveBeenCalledWith(
                expect.objectContaining({
                    packageName: 'test-package',
                    packageType: PackageType.Unlocked,
                    targetOrg: 'testOrg',
                })
            );
        });

        it('should emit install:complete event on success', async () => {
            const completeHandler = vi.fn();
            installer.on('install:complete', completeHandler);

            await installer.installPackage('test-package');

            expect(completeHandler).toHaveBeenCalledWith(
                expect.objectContaining({
                    packageName: 'test-package',
                    packageType: PackageType.Unlocked,
                    targetOrg: 'testOrg',
                    success: true,
                })
            );
        });

        it('should emit install:error event on failure', async () => {
            const errorHandler = vi.fn();
            installer.on('install:error', errorHandler);

            const error = new Error('Installation failed');
            mockInstallerInstance.exec.mockRejectedValue(error);

            await expect(installer.installPackage('test-package')).rejects.toThrow('Installation failed');

            expect(errorHandler).toHaveBeenCalledWith(
                expect.objectContaining({
                    packageName: 'test-package',
                    packageType: PackageType.Unlocked,
                    targetOrg: 'testOrg',
                    error: 'Installation failed',
                })
            );
        });

        it('should throw error if no installer is registered for package type', async () => {
            vi.mocked(InstallerRegistry.getInstaller).mockReturnValue(undefined);

            await expect(installer.installPackage('test-package')).rejects.toThrow(
                'No installer registered for package type: unlocked'
            );
        });

        it('should log error on installation failure', async () => {
            const error = new Error('Connection failed');
            mockInstallerInstance.connect.mockRejectedValue(error);

            await expect(installer.installPackage('test-package')).rejects.toThrow('Connection failed');

            expect(mockLogger.error).toHaveBeenCalledWith(
                expect.stringContaining('Failed to install test-package')
            );
        });

        it('should create installer with correct parameters', async () => {
            await installer.installPackage('test-package', '/custom/project');

            expect(mockInstallerConstructor).toHaveBeenCalledWith(
                'testOrg',
                mockPackage,
                mockLogger
            );
        });

        it('should use provided project directory', async () => {
            const customPath = '/custom/project';
            await installer.installPackage('test-package', customPath);

            expect(mockPackageFactoryInstance.createFromName).toHaveBeenCalledWith('test-package');
        });

        it('should use default project directory if not provided', async () => {
            await installer.installPackage('test-package');

            expect(mockPackageFactoryInstance.createFromName).toHaveBeenCalledWith('test-package');
        });

        it('should handle non-Error exceptions', async () => {
            const errorHandler = vi.fn();
            installer.on('install:error', errorHandler);

            mockInstallerInstance.exec.mockRejectedValue('String error');

            await expect(installer.installPackage('test-package')).rejects.toBe('String error');

            expect(errorHandler).toHaveBeenCalledWith(
                expect.objectContaining({
                    error: 'String error',
                })
            );
        });
    });
});
