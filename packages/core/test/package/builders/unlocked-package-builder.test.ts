import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import UnlockedPackageBuilder from '../../../src/package/builders/unlocked-package-builder.js';
import { BuilderOptions } from '../../../src/package/builders/builder-registry.js';
import { SfpmUnlockedPackage } from '../../../src/package/sfpm-package.js';
import { PackageType } from '../../../src/types/package.js';
import { Org, SfProject, Lifecycle } from '@salesforce/core';
import { PackageVersion } from '@salesforce/packaging';
import { Duration } from '@salesforce/kit';
import path from 'path';

// Mocks
vi.mock('@salesforce/core', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@salesforce/core')>();
    return {
        ...actual,
        Org: class {
            static create = vi.fn();
            getConnection = vi.fn();
            isDevHubOrg = vi.fn().mockReturnValue(true);
        },
        SfProject: class {
            static resolve = vi.fn();
            getSfProjectJson = vi.fn();
            getPath = vi.fn().mockReturnValue('/tmp/project');
        },
        Lifecycle: class {
            static getInstance = vi.fn();
        }
    };
});

vi.mock('@salesforce/packaging', async () => {
    return {
        PackageVersion: {
            create: vi.fn(),
        }
    };
});


vi.mock('../../../src/artifacts/artifact-assembler.js', () => {
    return {
        default: class {
            assemble = vi.fn().mockResolvedValue('/tmp/artifact.zip');
        }
    };
});

vi.mock('../../../src/package/builders/tasks/git-tag-task.js', () => {
    return {
        default: class {
            exec = vi.fn().mockResolvedValue(undefined);
        }
    };
});

describe('UnlockedPackageBuilder', () => {
    let builder: UnlockedPackageBuilder;
    let mockSfpmPackage: SfpmUnlockedPackage;
    let mockLogger: any;
    let mockOrg: any;
    let mockConnection: any;
    let mockLifecycle: any;
    let mockProject: any;
    let mockProjectJson: any;
    let lifecycleListeners: Record<string, Function> = {};
    let builderOptions: BuilderOptions;

    beforeEach(() => {
        // Setup Logger
        mockLogger = {
            info: vi.fn(),
            error: vi.fn(),
            warn: vi.fn(),
            debug: vi.fn(),
            trace: vi.fn(),
            log: vi.fn()
        };

        // Setup Package
        mockSfpmPackage = new SfpmUnlockedPackage('test-package', '/tmp/project', {
            identity: {
                packageType: PackageType.Unlocked,
                versionNumber: '1.0.0.0',
                packageName: 'test-package',
                isOrgDependent: false
            },
            orchestration: {
                build: {
                    waitTime: 60,
                    isCoverageEnabled: true,
                    installationKey: '123',
                    isSkipValidation: true,
                    isAsyncValidation: true,
                    postInstallScript: 'scripts/postinstall.sh'
                } as any
            }
        });

        // Set required staging directory for build
        mockSfpmPackage.stagingDirectory = '/tmp/project';

        // Builder options with npm scope for artifact assembly
        builderOptions = {
            npmScope: '@testorg'
        };

        // Setup Org Mock
        mockConnection = { getApiVersion: () => '50.0' };
        mockOrg = {
            getConnection: () => mockConnection,
            isDevHubOrg: () => true
        };
        (Org.create as any).mockResolvedValue(mockOrg);

        // Setup SfProject Mock
        mockProjectJson = {
            getContents: vi.fn().mockReturnValue({
                packageDirectories: [
                    { package: 'test-package', versionNumber: '1.0.0.0', path: 'packages/test-package' }
                ],
                packageAliases: {}
            })
        };
        mockProject = {
            getSfProjectJson: vi.fn().mockReturnValue(mockProjectJson),
            getPath: vi.fn().mockReturnValue('/tmp/project')
        };
        (SfProject.resolve as any).mockResolvedValue(mockProject);

        // Setup Lifecycle Mock
        lifecycleListeners = {};
        mockLifecycle = {
            on: vi.fn((event, listener) => {
                lifecycleListeners[event] = listener;
            }),
            removeListener: vi.fn(),
            removeAllListeners: vi.fn()
        };
        (Lifecycle.getInstance as any).mockReturnValue(mockLifecycle);


        builder = new UnlockedPackageBuilder('/tmp/project', mockSfpmPackage, builderOptions, mockLogger);
    });

    afterEach(() => {
        vi.clearAllMocks();
    });

    it('should build package successfully and update package version id', async () => {
        const expectedVersionId = '04t000000000000';

        // Mock PackageVersion.create logic
        (PackageVersion.create as any).mockImplementation(async (options: any, polling: any) => {
            // Simulate lifecycle events
            if (lifecycleListeners['packageVersionCreate:progress']) {
                await lifecycleListeners['packageVersionCreate:progress']({ Status: 'Queued' });
                await lifecycleListeners['packageVersionCreate:progress']({ Status: 'InProgress' });
            }
            return {
                Status: 'Success',
                SubscriberPackageVersionId: expectedVersionId,
                CodeCoverage: 80
            };
        });

        await builder.connect('test-user');
        await builder.exec();

        // Verify PackageVersion.create called with correct options
        expect(PackageVersion.create).toHaveBeenCalledWith(
            expect.objectContaining({
                installationkey: '123',
                versionnumber: '1.0.0.0',
                skipvalidation: true,
                codecoverage: true,
                asyncvalidation: true,
            }),
            expect.anything()
        );

        // Verify logging happened
        expect(mockLogger.info).toHaveBeenCalledWith(expect.stringContaining('Status: Queued'));
        expect(mockLogger.info).toHaveBeenCalledWith(expect.stringContaining('Status: InProgress'));
        expect(mockLogger.debug).toHaveBeenCalledWith(expect.stringContaining('Package Result'));

        // Verify package updated
        expect(mockSfpmPackage.packageVersionId).toBe(expectedVersionId);

        // Verify cleanup
        expect(mockLifecycle.removeAllListeners).toHaveBeenCalledWith('packageVersionCreate:progress');
    });

    it('should throw error on creation failure', async () => {
        (PackageVersion.create as any).mockResolvedValue({
            Status: 'Error',
            Error: ['Something went wrong']
        });

        await builder.connect('test-user');

        await expect(builder.exec()).rejects.toThrow('Package creation failed');
    });

    it('should throw error on low coverage', async () => {
        // Reset options to synchronous validation
        mockSfpmPackage = new SfpmUnlockedPackage('test-package', '/tmp/project', {
            identity: {
                packageType: PackageType.Unlocked,
                versionNumber: '1.0.0.0',
                packageName: 'test-package',
                isOrgDependent: false
            },
            orchestration: {
                build: {
                    waitTime: 60,
                    isCoverageEnabled: true,
                    installationKey: '123',
                    isSkipValidation: true,
                    isAsyncValidation: false // Sync
                } as any
            }
        });
        mockSfpmPackage.stagingDirectory = '/tmp/project';
        builder = new UnlockedPackageBuilder('/tmp/project', mockSfpmPackage, builderOptions, mockLogger);

        // Mock result
        (PackageVersion.create as any).mockResolvedValue({
            Status: 'Success',
            SubscriberPackageVersionId: '04t...',
            CodeCoverage: 50 // Too low
        });

        await builder.connect('test-user');

        await expect(builder.exec()).rejects.toThrow('minimum coverage requirement');
    });

    it('should skip coverage check if async validation is enabled', async () => {
        (PackageVersion.create as any).mockResolvedValue({
            Status: 'Success',
            SubscriberPackageVersionId: '04t...',
            CodeCoverage: null // Async result might not have coverage
        });

        await builder.connect('test-user');

        // Should not throw
        await expect(builder.exec()).resolves.not.toThrow();
    });

});
