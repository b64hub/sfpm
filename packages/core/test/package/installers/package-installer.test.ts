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
            getPackageDir: vi.fn().mockReturnValue('/test/project/node_modules/@test/test-package'),
        };

        mockPackage = {
            name: 'test-package',
            npmName: '@test/test-package',
            packageName: 'test-package',
            type: PackageType.Unlocked,
            projectDir: '/test/project',
            version: '1.0.0',
            packageDefinition: { path: 'node_modules/@test/test-package/force-app' },
        };

        mockInstallerInstance = {
            connect: vi.fn().mockResolvedValue(undefined),
            isInstalled: vi.fn().mockResolvedValue({ needsInstall: true, installReason: 'not-installed' }),
            run: vi.fn().mockResolvedValue({ installId: 'deploy-123' }),
        };

        mockInstallerConstructor = vi.fn(function(this: any) {
            return mockInstallerInstance;
        }) as any;

        mockPackageFactoryInstance = {
            createFromName: vi.fn().mockReturnValue(mockPackage),
            isManagedPackage: vi.fn().mockReturnValue(false),
            createManagedRef: vi.fn().mockReturnValue(null),
        };

        vi.mocked(PackageFactory).mockImplementation(vi.fn(function(this: any) {
            return mockPackageFactoryInstance;
        }) as any);

        vi.spyOn(InstallerRegistry, 'getInstaller').mockReturnValue(mockInstallerConstructor);

        installBus = new InstallEventBus();

        installer = new PackageInstaller(
            mockOrg as any,
            mockProvider,
            {},
            mockLogger,
            installBus,
        );

        vi.clearAllMocks();
    });

    describe('install', () => {
        it('should throw if target org not connected', async () => {
            const noOrgInstaller = new PackageInstaller(
                undefined as any,
                mockProvider,
                {},
                mockLogger,
            );
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

            mockInstallerInstance.run.mockRejectedValue(new Error('Installation failed'));

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
                mockOrg as any,
                mockProvider,
                { force: true },
                mockLogger,
                installBus,
            );

            await forceInstaller.install('test-package');

            expect(mockInstallerInstance.isInstalled).not.toHaveBeenCalled();
            expect(mockInstallerInstance.run).toHaveBeenCalled();
        });
    });
});
