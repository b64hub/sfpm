import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import UnlockedPackageBuilder from '../../../src/package/builders/unlocked-package-builder.js';
import { BuilderOptions } from '../../../src/package/builders/builder-registry.js';
import { SfpmUnlockedPackage } from '../../../src/package/sfpm-package.js';
import { PackageType } from '../../../src/types/package.js';
import { Org, SfProject, Lifecycle } from '@salesforce/core';
import { PackageVersion } from '@salesforce/packaging';
import { Duration } from '@salesforce/kit';
import fs from 'fs-extra';
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
            getCreateStatus: vi.fn(),
        }
    };
});

vi.mock('fs-extra', async () => {
    const actual = await import('fs-extra');
    return {
        ...actual,
        default: {
            ...actual,
            pathExists: vi.fn().mockResolvedValue(false),
            readJson: vi.fn().mockResolvedValue({}),
            writeJson: vi.fn().mockResolvedValue(undefined),
        },
    };
});


vi.mock('../../../src/artifacts/artifact-assembler.js', () => {
    return {
        default: class {
            assemble = vi.fn().mockResolvedValue('/tmp/artifact.zip');
        }
    };
});

vi.mock('../../../src/package/builders/tasks/assemble-artifact-task.js', () => ({
    assembleArtifactTask: () => () => ({
        name: 'assemble-artifact',
        exec: vi.fn().mockResolvedValue(undefined),
    }),
}));

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
                    installationKey: '123',
                    postInstallScript: 'scripts/postinstall.sh'
                }
            }
        });

        // Set required staging directory for build
        mockSfpmPackage.workingDirectory = '/tmp/project';

        // Builder options — SF API params now flow through here
        builderOptions = {
            validation: true,
            installationKey: '123',
            waitTime: 60,
        };

        // Setup Org Mock
        mockConnection = { getApiVersion: () => '50.0' };
        mockOrg = {
            getConnection: () => mockConnection,
            getUsername: () => 'test-user',
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

    describe('createPackageVersion', () => {
        it('should call PackageVersion.create with correct options and update package version id', async () => {
            const expectedVersionId = '04t000000000000';

            (PackageVersion.create as any).mockImplementation(async (options: any, polling: any) => {
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

            expect(PackageVersion.create).toHaveBeenCalledWith(
                expect.objectContaining({
                    installationkey: '123',
                    versionnumber: '1.0.0.0',
                    skipvalidation: false,
                    codecoverage: true,
                    asyncvalidation: true,
                }),
                expect.anything()
            );

            expect(mockSfpmPackage.packageVersionId).toBe(expectedVersionId);
            expect(mockSfpmPackage.validationState).toBeDefined();
            expect(mockSfpmPackage.validationState!.status).toBe('pending');
            expect(mockSfpmPackage.validationState!.checks).toContain('test');
            expect(mockSfpmPackage.validationState!.checks).toContain('dependencies');
            expect((mockSfpmPackage.validationState as any).pending.operationType).toBe('package-version-request');
            expect(mockLogger.debug).toHaveBeenCalledWith(expect.stringContaining('Package Result'));
            expect(mockLifecycle.removeAllListeners).toHaveBeenCalledWith('packageVersionCreate:progress');
        });

        it('should throw error when result has no SubscriberPackageVersionId', async () => {
            (PackageVersion.create as any).mockResolvedValue({
                Status: 'Error',
                Error: ['Something went wrong']
            });

            await builder.connect('test-user');

            await expect(builder.exec()).rejects.toThrow('Package creation failed');
        });
    });

    describe('handleCreateProgress', () => {
        it('should emit progress events and log status during polling', async () => {
            const expectedVersionId = '04t000000000000';

            (PackageVersion.create as any).mockImplementation(async () => {
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

            expect(mockLogger.info).toHaveBeenCalledWith(expect.stringContaining('Status: Queued'));
            expect(mockLogger.info).toHaveBeenCalledWith(expect.stringContaining('Status: InProgress'));
        });
    });

    describe('applyCreateResult', () => {
        it('should not throw on low coverage when validation is async', async () => {
            (PackageVersion.create as any).mockResolvedValue({
                Status: 'Success',
                SubscriberPackageVersionId: '04t...',
                CodeCoverage: 50,
                HasPassedCodeCoverageCheck: false,
            });

            await builder.connect('test-user');

            await expect(builder.exec()).resolves.not.toThrow();
            expect(mockSfpmPackage.validationState).toMatchObject({
                checks: ['deploy', 'test', 'dependencies'],
                status: 'pending',
                pending: expect.objectContaining({
                    operationType: 'package-version-request',
                }),
            });
        });

        it('should set empty checks when validation is skipped', async () => {
            const skipBuilder = new UnlockedPackageBuilder('/tmp/project', mockSfpmPackage, {
                validation: false,
                installationKey: '123',
            }, mockLogger);

            (PackageVersion.create as any).mockResolvedValue({
                Status: 'Success',
                SubscriberPackageVersionId: '04t...',
                CodeCoverage: null,
            });

            await skipBuilder.connect('test-user');
            await skipBuilder.exec();

            expect(mockSfpmPackage.validationState).toEqual({
                checks: [],
                status: 'passed',
            });
        });
    });

    describe('rewriteMetadataPathsForCwd', () => {
        it('should rewrite staging-relative metadata paths to CWD-relative before build', async () => {
            const stagingDir = '/tmp/staging/package';
            const cwd = process.cwd();
            mockSfpmPackage.workingDirectory = stagingDir;
            builder = new UnlockedPackageBuilder(stagingDir, mockSfpmPackage, builderOptions, mockLogger);

            const stagedProjectJson = {
                packageDirectories: [{
                    package: 'test-package',
                    path: 'package',
                    default: true,
                    seedMetadata: { path: 'seedMetadata' },
                    unpackagedMetadata: { path: 'unpackagedMetadata' },
                }],
            };

            (fs.pathExists as any).mockResolvedValue(true);
            (fs.readJson as any).mockResolvedValue(stagedProjectJson);

            (PackageVersion.create as any).mockResolvedValue({
                Status: 'Success',
                SubscriberPackageVersionId: '04t000000000000',
            });

            await builder.connect('test-user');
            await builder.exec();

            expect(fs.writeJson).toHaveBeenCalledWith(
                path.join(stagingDir, 'sfdx-project.json'),
                expect.objectContaining({
                    packageDirectories: [expect.objectContaining({
                        seedMetadata: { path: path.relative(cwd, path.resolve(stagingDir, 'seedMetadata')) },
                        unpackagedMetadata: { path: path.relative(cwd, path.resolve(stagingDir, 'unpackagedMetadata')) },
                    })],
                }),
                { spaces: 4 },
            );
        });
    });

    describe('handleCreateFailure', () => {
        const requestId = '08c000000000001';

        beforeEach(() => {
            // Ensure getUsername is available for error messages
            mockOrg.getUsername = vi.fn().mockReturnValue('test-user');

            // All recovery tests: create() fails after emitting progress with a request ID
            (PackageVersion.create as any).mockImplementation(async () => {
                if (lifecycleListeners['packageVersionCreate:progress']) {
                    await lifecycleListeners['packageVersionCreate:progress']({
                        Id: requestId,
                        Status: 'InProgress',
                    });
                }

                throw new Error('socket hang up');
            });
        });

        it('should recover when server-side creation succeeded despite client error', async () => {
            const expectedVersionId = '04t000000000AAA';

            (PackageVersion.getCreateStatus as any).mockResolvedValue({
                Id: requestId,
                Status: 'Success',
                SubscriberPackageVersionId: expectedVersionId,
                VersionNumber: '1.0.0.5',
                Package2Id: '0Ho000000000001',
            });

            await builder.connect('test-user');
            await builder.exec();

            expect(PackageVersion.getCreateStatus).toHaveBeenCalledWith(requestId, mockConnection);
            expect(mockSfpmPackage.packageVersionId).toBe(expectedVersionId);
            expect(mockLogger.info).toHaveBeenCalledWith(
                expect.stringContaining('succeeded server-side'),
            );
        });

        it('should throw with server errors when server-side creation failed', async () => {
            (PackageVersion.getCreateStatus as any).mockResolvedValue({
                Id: requestId,
                Status: 'Error',
                Error: [{Message: 'Apex compilation failed'}],
            });

            await builder.connect('test-user');

            await expect(builder.exec()).rejects.toThrow('Apex compilation failed');
        });

        it('should throw with request ID when creation is still in progress', async () => {
            (PackageVersion.getCreateStatus as any).mockResolvedValue({
                Id: requestId,
                Status: 'InProgress',
            });

            await builder.connect('test-user');

            const error = await builder.exec().catch((e: Error) => e);
            expect(error).toBeInstanceOf(Error);
            expect(error!.message).toContain('still in progress');
            expect(error!.message).toContain(requestId);
        });

        it('should fall through to timeout handler when verify query also fails', async () => {
            (PackageVersion.getCreateStatus as any).mockRejectedValue(
                new Error('connection refused'),
            );

            await builder.connect('test-user');

            // Verify query fails → falls through to existing timeout detection
            // (lastStatus is 'InProgress', so timeout path matches)
            const error = await builder.exec().catch((e: Error) => e);
            expect(error).toBeInstanceOf(Error);
            expect(error!.message).toContain('timed out');
            expect(error!.message).toContain(requestId);
        });
    });

});
