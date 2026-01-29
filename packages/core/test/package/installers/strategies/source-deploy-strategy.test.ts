import { describe, it, expect, beforeEach, vi } from 'vitest';
import SourceDeployStrategy from '../../../../src/package/installers/strategies/source-deploy-strategy.js';
import { InstallationSourceType, InstallationMode, PackageType } from '../../../../src/types/package.js';
import { SfpmUnlockedPackage, SfpmSourcePackage } from '../../../../src/package/sfpm-package.js';
import { Org } from '@salesforce/core';
import { ComponentSet } from '@salesforce/source-deploy-retrieve';

// Mocks
vi.mock('@salesforce/core', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@salesforce/core')>();
    return {
        ...actual,
        Org: {
            create: vi.fn(),
        },
    };
});

vi.mock('@salesforce/source-deploy-retrieve', () => ({
    ComponentSet: {
        fromSource: vi.fn(),
    },
}));

describe('SourceDeployStrategy', () => {
    let strategy: SourceDeployStrategy;
    let mockLogger: any;

    beforeEach(() => {
        mockLogger = {
            info: vi.fn(),
            error: vi.fn(),
        };
        strategy = new SourceDeployStrategy(mockLogger);
        vi.clearAllMocks();
    });

    describe('canHandle', () => {
        it('should handle source packages from any source type', () => {
            const sourcePackage = Object.create(SfpmSourcePackage.prototype);
            
            expect(strategy.canHandle(InstallationSourceType.LocalSource, sourcePackage)).toBe(true);
            expect(strategy.canHandle(InstallationSourceType.BuiltArtifact, sourcePackage)).toBe(true);
            expect(strategy.canHandle(InstallationSourceType.RemoteNpm, sourcePackage)).toBe(true);
        });

        it('should handle unlocked packages from local source', () => {
            const unlockedPackage = Object.create(SfpmUnlockedPackage.prototype);
            
            expect(strategy.canHandle(InstallationSourceType.LocalSource, unlockedPackage)).toBe(true);
        });

        it('should not handle unlocked packages from artifact or npm', () => {
            const unlockedPackage = Object.create(SfpmUnlockedPackage.prototype);
            
            expect(strategy.canHandle(InstallationSourceType.BuiltArtifact, unlockedPackage)).toBe(false);
            expect(strategy.canHandle(InstallationSourceType.RemoteNpm, unlockedPackage)).toBe(false);
        });
    });

    describe('getMode', () => {
        it('should return SourceDeploy mode', () => {
            expect(strategy.getMode()).toBe(InstallationMode.SourceDeploy);
        });
    });

    describe('install', () => {
        let mockPackage: any;
        let mockOrg: any;
        let mockConnection: any;
        let mockComponentSet: any;
        let mockDeploy: any;

        beforeEach(() => {
            mockPackage = {
                packageName: 'test-package',
                packageDirectory: '/path/to/package',
            };

            mockConnection = {
                tooling: {},
            };

            mockOrg = {
                getConnection: vi.fn().mockReturnValue(mockConnection),
            };

            mockDeploy = {
                pollStatus: vi.fn().mockResolvedValue({
                    response: {
                        success: true,
                        details: {},
                    },
                }),
                onUpdate: vi.fn(),
            };

            mockComponentSet = {
                deploy: vi.fn().mockResolvedValue(mockDeploy),
                size: 10,
            };

            vi.mocked(Org.create).mockResolvedValue(mockOrg as any);
            vi.mocked(ComponentSet.fromSource).mockReturnValue(mockComponentSet as any);
        });

        it('should successfully deploy package source', async () => {
            await strategy.install(mockPackage, 'targetOrg');

            expect(Org.create).toHaveBeenCalledWith({ aliasOrUsername: 'targetOrg' });
            expect(ComponentSet.fromSource).toHaveBeenCalledWith('/path/to/package');
            expect(mockComponentSet.deploy).toHaveBeenCalledWith({
                usernameOrConnection: mockConnection,
            });
            expect(mockDeploy.pollStatus).toHaveBeenCalled();
            expect(mockLogger.info).toHaveBeenCalledWith('Source deployment completed successfully');
        });

        it('should throw error if package directory is not available', async () => {
            mockPackage.packageDirectory = undefined;

            await expect(strategy.install(mockPackage, 'targetOrg')).rejects.toThrow(
                'Unable to determine source path for package: test-package'
            );
        });

        it('should throw error if connection is not available', async () => {
            mockOrg.getConnection.mockReturnValue(null);

            await expect(strategy.install(mockPackage, 'targetOrg')).rejects.toThrow(
                'Unable to connect to org: targetOrg'
            );
        });

        it('should throw error if deployment fails', async () => {
            mockDeploy.pollStatus.mockResolvedValue({
                response: {
                    success: false,
                    details: {
                        componentFailures: [
                            { fullName: 'ApexClass.Test', problem: 'Syntax error' },
                        ],
                    },
                },
            });

            await expect(strategy.install(mockPackage, 'targetOrg')).rejects.toThrow(
                'Source deployment failed:\nApexClass.Test: Syntax error'
            );
        });

        it('should handle single failure object', async () => {
            mockDeploy.pollStatus.mockResolvedValue({
                response: {
                    success: false,
                    details: {
                        componentFailures: { fullName: 'ApexClass.Test', problem: 'Error' },
                    },
                },
            });

            await expect(strategy.install(mockPackage, 'targetOrg')).rejects.toThrow(
                'Source deployment failed:\nApexClass.Test: Error'
            );
        });

        it('should handle deployment failure with no specific errors', async () => {
            mockDeploy.pollStatus.mockResolvedValue({
                response: {
                    success: false,
                    details: {},
                },
            });

            await expect(strategy.install(mockPackage, 'targetOrg')).rejects.toThrow(
                'Source deployment failed:\nUnknown deployment error'
            );
        });
    });
});
