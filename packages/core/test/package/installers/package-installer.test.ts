import { describe, it, expect, beforeEach, vi } from 'vitest';
import PackageInstaller from '../../../src/package/package-installer.js';
import { InstallEventBus } from '../../../src/events/install-event-bus.js';
import { InstallerRegistry } from '../../../src/package/installers/installer-registry.js';
import { PackageFactory } from '../../../src/package/sfpm-package.js';
import { PackageType } from '../../../src/types/package.js';

// Mocks
vi.mock('../../../src/package/sfpm-package.js');

vi.mock('@salesforce/core', () => ({
    Org: {
        create: vi.fn().mockResolvedValue({
            getUsername: vi.fn().mockReturnValue('test@org.com'),
            getConnection: vi.fn().mockReturnValue({}),
        }),
    },
}));

// Mock the ArtifactService singleton
vi.mock('../../../src/artifacts/artifact-service.js', () => ({
    ArtifactService: {
        getInstance: vi.fn().mockReturnValue({
            setOrg: vi.fn().mockReturnThis(),
            setLogger: vi.fn().mockReturnThis(),
            setProjectDir: vi.fn().mockReturnThis(),
            getBuildOutput: vi.fn().mockReturnValue('/test/project/packages/test-package/artifact/package'),
            resolveArtifact: vi.fn().mockResolvedValue({
                resolved: {
                    source: 'local',
                    version: '1.0.0',
                    artifactPath: '/test/project/packages/test-package/artifact/package',
                    manifest: { sourceHash: 'abc123', schemaVersion: 2, source: 'local' },
                },
                orgStatus: { isInstalled: false },
                packageName: 'test-package',
            }),
            upsertArtifact: vi.fn().mockResolvedValue(undefined),
            createHistoryRecord: vi.fn().mockResolvedValue(undefined),
        }),
    },
}));

// Mock workspace-path
vi.mock('../../../src/utils/workspace-path.js', () => ({
    resolvePackageWorkspacePath: vi.fn().mockReturnValue('/test/project/packages/test-package'),
}));

describe('PackageInstaller', () => {
    let installer: PackageInstaller;
    let installBus: InstallEventBus;
    let mockProvider: any;
    let mockLogger: any;
    let mockOrg: any;
    let mockPackageFactoryInstance: any;
    let mockPackage: any;
    let mockInstallerInstance: any;
    let mockInstallerConstructor: any;

    beforeEach(() => {
        mockLogger = {
            info: vi.fn(),
            error: vi.fn(),
            debug: vi.fn(),
            warn: vi.fn(),
        };

        mockOrg = {
            getUsername: vi.fn().mockReturnValue('test@org.com'),
            getConnection: vi.fn().mockReturnValue({}),
        };

        mockProvider = {
            projectDir: '/test/project',
        };

        mockPackage = {
            name: 'test-package',
            npmName: '@test/test-package',
            packageName: 'test-package',
            type: PackageType.Unlocked,
            projectDir: '/test/project',
            version: '1.0.0',
            packageDefinition: { path: 'packages/test-package/force-app' },
            metadata: { source: {} },
        };

        mockInstallerInstance = {
            connect: vi.fn().mockResolvedValue(undefined),
            isInstalled: vi.fn().mockResolvedValue({ needsInstall: true, installReason: 'not-installed' }),
            run: vi.fn().mockResolvedValue({ installId: 'deploy-123' }),
        };

        // Create a proper constructor mock that returns the instance
        mockInstallerConstructor = vi.fn(function(this: any) {
            return mockInstallerInstance;
        }) as any;

        // Create package factory instance
        mockPackageFactoryInstance = {
            createFromName: vi.fn().mockReturnValue(mockPackage),
            isManagedPackage: vi.fn().mockReturnValue(false),
            createManagedRef: vi.fn().mockReturnValue(null),
        };

        vi.mocked(PackageFactory).mockImplementation(vi.fn(function(this: any) {
            return mockPackageFactoryInstance;
        }) as any);

        // Mock registry
        vi.spyOn(InstallerRegistry, 'getInstaller').mockReturnValue(mockInstallerConstructor);

        installBus = new InstallEventBus();

        // Constructor: (provider, options, logger, targetOrg?, bus?)
        installer = new PackageInstaller(
            mockProvider,
            {},
            mockLogger,
            mockOrg as any,
            installBus,
        );

        vi.clearAllMocks();
    });

    describe('install', () => {
        it('should throw if target org not connected', async () => {
            const noOrgInstaller = new PackageInstaller(mockProvider, {}, mockLogger);
            await expect(noOrgInstaller.install('test-package')).rejects.toThrow(
                'Target org not connected'
            );
        });

        it('should successfully install a package via installArtifact', async () => {
            await installer.install('test-package');

            expect(PackageFactory).toHaveBeenCalledWith(mockProvider);
            expect(mockPackageFactoryInstance.createFromName).toHaveBeenCalledWith('test-package');
            expect(mockInstallerInstance.run).toHaveBeenCalled();
        });

        it('should emit install:start event', async () => {
            const startHandler = vi.fn();
            installBus.on('start', startHandler);

            await installer.install('test-package');

            expect(startHandler).toHaveBeenCalledWith(
                expect.objectContaining({
                    packageName: 'test-package',
                    packageType: PackageType.Unlocked,
                })
            );
        });

        it('should emit install:complete event on success', async () => {
            const completeHandler = vi.fn();
            installBus.on('complete', completeHandler);

            await installer.install('test-package');

            expect(completeHandler).toHaveBeenCalledWith(
                expect.objectContaining({
                    packageName: 'test-package',
                    packageType: PackageType.Unlocked,
                    success: true,
                })
            );
        });

        it('should emit install:error event on failure', async () => {
            const errorHandler = vi.fn();
            installBus.on('error', errorHandler);

            const error = new Error('Installation failed');
            mockInstallerInstance.run.mockRejectedValue(error);

            await expect(installer.install('test-package')).rejects.toThrow('Installation failed');

            expect(errorHandler).toHaveBeenCalledWith(
                expect.objectContaining({
                    packageName: 'test-package',
                    error: 'Installation failed',
                })
            );
        });

        it('should skip install when isInstalled returns needsInstall: false', async () => {
            mockInstallerInstance.isInstalled.mockResolvedValue({
                needsInstall: false,
                installReason: 'hash-match',
            });

            const skipHandler = vi.fn();
            installBus.on('skip', skipHandler);

            const result = await installer.install('test-package');

            expect(result.skipped).toBe(true);
            expect(result.skipReason).toBe('hash-match');
            expect(mockInstallerInstance.run).not.toHaveBeenCalled();
        });

        it('should force install even when already installed', async () => {
            mockInstallerInstance.isInstalled.mockResolvedValue({
                needsInstall: false,
                installReason: 'hash-match',
            });

            const forceInstaller = new PackageInstaller(
                mockProvider,
                { force: true },
                mockLogger,
                mockOrg as any,
                installBus,
            );

            await forceInstaller.install('test-package');

            // isInstalled should not be called when force is true
            expect(mockInstallerInstance.isInstalled).not.toHaveBeenCalled();
            expect(mockInstallerInstance.run).toHaveBeenCalled();
        });
    });
});
