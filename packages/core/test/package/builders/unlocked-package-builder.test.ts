import path from 'node:path';
import {
  beforeEach, describe, expect, it, vi,
} from 'vitest';

import UnlockedPackageBuilder from '../../../src/package/builders/unlocked-package-builder.js';
import {SfpmSourcePackage, SfpmUnlockedPackage} from '../../../src/package/sfpm-package.js';
import {BuildError} from '../../../src/types/errors.js';
import {BuildOptions} from '../../../src/types/package.js';

// ============================================================================
// Hoisted mocks (accessible inside vi.mock factories)
// ============================================================================

const {
  mockCreatePackageVersion, mockGetVersionCreateStatus, mockPathExists, mockReadJson, mockResolveBuildConfig, mockWriteJson,
} = vi.hoisted(() => ({
  mockCreatePackageVersion: vi.fn(),
  mockGetVersionCreateStatus: vi.fn(),
  mockPathExists: vi.fn(),
  mockReadJson: vi.fn(),
  mockResolveBuildConfig: vi.fn(),
  mockWriteJson: vi.fn(),
}));

// UnlockedPackageBuilder delegates the actual SDK calls (SfProject, Lifecycle,
// PackageVersion.create/getCreateStatus) to PackageService, which has its own
// dedicated test suite (package-service.test.ts). Mocking PackageService here
// keeps this suite scoped to the builder's own logic: option resolution,
// installation-key lookup, result hydration, and the create-failure recovery flow.
vi.mock('../../../src/package/package-service.js', () => ({
  default: function PackageService() {
    return {
      createPackageVersion: mockCreatePackageVersion,
      getVersionCreateStatus: mockGetVersionCreateStatus,
    };
  },
}));

// resolveBuildConfig() merges per-package project config with runtime options —
// that layering is ProjectService's own concern. Here it just echoes the
// runtime options back so tests control the exact BuildOptions the builder sees.
vi.mock('../../../src/project/project-service.js', () => ({
  default: {
    getInstance: vi.fn().mockResolvedValue({
      resolveBuildConfig: mockResolveBuildConfig,
    }),
  },
}));

vi.mock('fs-extra', () => ({
  default: {
    pathExists: mockPathExists,
    readJson: mockReadJson,
    writeJson: mockWriteJson,
  },
}));

describe('UnlockedPackageBuilder', () => {
  let mockLogger: any;
  let mockProvider: any;
  let mockDevhub: any;
  let mockSfpmPackage: InstanceType<typeof SfpmUnlockedPackage>;
  let baseOptions: BuildOptions;

  beforeEach(() => {
    vi.clearAllMocks();

    mockLogger = {
      debug: vi.fn(),
      error: vi.fn(),
      info: vi.fn(),
      trace: vi.fn(),
      warn: vi.fn(),
    };

    mockProvider = {
      getPackageBuildDirectory: vi.fn().mockReturnValue('/tmp/project'),
    };

    mockDevhub = {
      getUsername: vi.fn().mockReturnValue('devhub-user'),
      isDevHubOrg: vi.fn().mockReturnValue(true),
    };

    mockSfpmPackage = new SfpmUnlockedPackage('test-package', '/tmp/project');
    mockSfpmPackage.packageId = '0Ho000000000001';
    mockSfpmPackage.version = '1.0.0.0';
    mockSfpmPackage.isOrgDependent = false;
    mockSfpmPackage.tag = 'my-tag';

    baseOptions = {validation: 'full', waitTime: 60};

    mockResolveBuildConfig.mockImplementation((_packageName: string, runtimeOptions?: BuildOptions) => runtimeOptions ?? {});
    mockPathExists.mockResolvedValue(false);

    mockCreatePackageVersion.mockImplementation(async (_packageId: string, _options: any, onProgress?: (p: any) => void) => {
      onProgress?.({Id: '08c000000000001', Status: 'InProgress'});
      return {
        Id: '08c000000000001',
        Status: 'Success',
        SubscriberPackageVersionId: '04t000000000AAA',
        VersionNumber: '1.0.0.5',
      };
    });
  });

  it('rejects a package that is not an unlocked package', () => {
    const notUnlocked = new SfpmSourcePackage('other-package', '/tmp/project');

    expect(() => new UnlockedPackageBuilder(mockProvider, notUnlocked, baseOptions, mockLogger))
    .toThrow(TypeError);
  });

  describe('connect', () => {
    it('throws a BuildError when no org is provided', async () => {
      const builder = new UnlockedPackageBuilder(mockProvider, mockSfpmPackage, baseOptions, mockLogger);

      await expect(builder.connect()).rejects.toThrow(BuildError);
    });

    it('throws a BuildError when the org is not a dev hub', async () => {
      mockDevhub.isDevHubOrg.mockReturnValue(false);
      const builder = new UnlockedPackageBuilder(mockProvider, mockSfpmPackage, baseOptions, mockLogger);

      await expect(builder.connect(mockDevhub)).rejects.toThrow(BuildError);
    });
  });

  it('throws when exec() is called before connect()', async () => {
    const builder = new UnlockedPackageBuilder(mockProvider, mockSfpmPackage, baseOptions, mockLogger);

    await expect(builder.exec()).rejects.toThrow('Must run connect() before exec()');
  });

  describe('exec', () => {
    it('creates the package version, hydrates the package, and reports pending validation', async () => {
      const builder = new UnlockedPackageBuilder(mockProvider, mockSfpmPackage, baseOptions, mockLogger);
      await builder.connect(mockDevhub);
      const expectedVersionNumber = mockSfpmPackage.getVersionNumber('salesforce');

      const result = await builder.exec();

      expect(mockCreatePackageVersion).toHaveBeenCalledWith(
        '0Ho000000000001',
        expect.objectContaining({
          apiVersion: mockSfpmPackage.apiVersion,
          asyncvalidation: true,
          codecoverage: true,
          installationkey: undefined,
          installationkeybypass: true,
          skipvalidation: false,
          tag: 'my-tag',
          versionnumber: expectedVersionNumber,
          wait: 60,
        }),
        expect.any(Function),
      );

      expect(mockSfpmPackage.packageVersionId).toBe('04t000000000AAA');
      expect(result).toMatchObject({
        packageName: mockSfpmPackage.name,
        packageVersionId: '04t000000000AAA',
        pendingValidation: {
          devhub: 'devhub-user',
          operationType: 'package-version-request',
          packageName: mockSfpmPackage.packageName,
          packageVersionRequestId: '08c000000000001',
        },
      });
      expect(mockLogger.info).toHaveBeenCalledWith(expect.stringContaining('Status: InProgress'));
    });

    it('skips validation and installation-key bypass changes with validation: none', async () => {
      const builder = new UnlockedPackageBuilder(mockProvider, mockSfpmPackage, {...baseOptions, validation: 'none'}, mockLogger);
      await builder.connect(mockDevhub);

      await builder.exec();

      expect(mockCreatePackageVersion).toHaveBeenCalledWith(
        '0Ho000000000001',
        expect.objectContaining({asyncvalidation: false, codecoverage: false, skipvalidation: true}),
        expect.any(Function),
      );
    });

    it('skips async validation for org-dependent packages even when validation is enabled', async () => {
      mockSfpmPackage.isOrgDependent = true;
      const builder = new UnlockedPackageBuilder(mockProvider, mockSfpmPackage, baseOptions, mockLogger);
      await builder.connect(mockDevhub);

      await builder.exec();

      expect(mockCreatePackageVersion).toHaveBeenCalledWith(
        '0Ho000000000001',
        expect.objectContaining({asyncvalidation: false}),
        expect.any(Function),
      );
    });

    describe('installation key resolution', () => {
      it('falls back to the wildcard key when the package has no explicit entry', async () => {
        const options: BuildOptions = {...baseOptions, unlocked: {installationKeys: {'*': 'default-key'}}};
        const builder = new UnlockedPackageBuilder(mockProvider, mockSfpmPackage, options, mockLogger);
        await builder.connect(mockDevhub);

        await builder.exec();

        expect(mockCreatePackageVersion).toHaveBeenCalledWith(
          '0Ho000000000001',
          expect.objectContaining({installationkey: 'default-key', installationkeybypass: undefined}),
          expect.any(Function),
        );
      });

      it('prefers a package-specific key over the wildcard', async () => {
        const options: BuildOptions = {
          ...baseOptions,
          unlocked: {installationKeys: {'*': 'default-key', 'test-package': 'specific-key'}},
        };
        const builder = new UnlockedPackageBuilder(mockProvider, mockSfpmPackage, options, mockLogger);
        await builder.connect(mockDevhub);

        await builder.exec();

        expect(mockCreatePackageVersion).toHaveBeenCalledWith(
          '0Ho000000000001',
          expect.objectContaining({installationkey: 'specific-key', installationkeybypass: undefined}),
          expect.any(Function),
        );
      });

      it('bypasses the installation key when no key applies to this package', async () => {
        const options: BuildOptions = {...baseOptions, unlocked: {installationKeys: {'other-package': 'irrelevant-key'}}};
        const builder = new UnlockedPackageBuilder(mockProvider, mockSfpmPackage, options, mockLogger);
        await builder.connect(mockDevhub);

        await builder.exec();

        expect(mockCreatePackageVersion).toHaveBeenCalledWith(
          '0Ho000000000001',
          expect.objectContaining({installationkey: undefined, installationkeybypass: true}),
          expect.any(Function),
        );
      });
    });
  });

  describe('create failure recovery', () => {
    const requestId = '08c000000000002';

    beforeEach(() => {
      // All recovery tests: create() fails after emitting progress with a request ID.
      mockCreatePackageVersion.mockImplementation(async (_packageId: string, _options: any, onProgress?: (p: any) => void) => {
        onProgress?.({Id: requestId, Status: 'InProgress'});
        throw new Error('socket hang up');
      });
    });

    it('recovers when server-side creation succeeded despite the client error', async () => {
      mockGetVersionCreateStatus.mockResolvedValue({
        Id: requestId,
        Package2Id: '0Ho000000000001',
        Status: 'Success',
        SubscriberPackageVersionId: '04t000000000BBB',
        VersionNumber: '1.0.0.6',
      });

      const builder = new UnlockedPackageBuilder(mockProvider, mockSfpmPackage, baseOptions, mockLogger);
      await builder.connect(mockDevhub);

      await expect(builder.exec()).resolves.not.toThrow();

      expect(mockGetVersionCreateStatus).toHaveBeenCalledWith(requestId);
      expect(mockSfpmPackage.packageVersionId).toBe('04t000000000BBB');
      expect(mockLogger.info).toHaveBeenCalledWith(expect.stringContaining('succeeded server-side'));
    });

    it('throws with the server error when server-side creation failed', async () => {
      mockGetVersionCreateStatus.mockResolvedValue({
        Error: [{Message: 'Apex compilation failed'}],
        Id: requestId,
        Status: 'Error',
      });

      const builder = new UnlockedPackageBuilder(mockProvider, mockSfpmPackage, baseOptions, mockLogger);
      await builder.connect(mockDevhub);

      await expect(builder.exec()).rejects.toThrow('Apex compilation failed');
    });

    it('throws referencing the request ID when creation is still in progress server-side', async () => {
      mockGetVersionCreateStatus.mockResolvedValue({Id: requestId, Status: 'InProgress'});

      const builder = new UnlockedPackageBuilder(mockProvider, mockSfpmPackage, baseOptions, mockLogger);
      await builder.connect(mockDevhub);

      const error = await builder.exec().catch((error_: Error) => error_);
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toContain('still in progress');
      expect((error as Error).message).toContain(requestId);
    });

    it('falls through to the timeout handler when the verify query itself fails', async () => {
      mockGetVersionCreateStatus.mockRejectedValue(new Error('connection refused'));

      const builder = new UnlockedPackageBuilder(mockProvider, mockSfpmPackage, baseOptions, mockLogger);
      await builder.connect(mockDevhub);

      const error = await builder.exec().catch((error_: Error) => error_);
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toContain('timed out');
      expect((error as Error).message).toContain(requestId);
    });

    it('throws the original error when no request ID was ever captured', async () => {
      mockCreatePackageVersion.mockRejectedValue(new Error('immediate connection failure'));

      const builder = new UnlockedPackageBuilder(mockProvider, mockSfpmPackage, baseOptions, mockLogger);
      await builder.connect(mockDevhub);

      await expect(builder.exec()).rejects.toThrow('immediate connection failure');
      expect(mockGetVersionCreateStatus).not.toHaveBeenCalled();
    });
  });

  describe('rewriteMetadataPathsForCwd', () => {
    it('rewrites staging-relative metadata paths to CWD-relative before build', async () => {
      const stagingDir = '/tmp/staging/package';
      mockProvider.getPackageBuildDirectory.mockReturnValue(stagingDir);

      const stagedProjectJson = {
        packageDirectories: [{
          default: true,
          package: 'test-package',
          path: 'package',
          seedMetadata: {path: 'seedMetadata'},
          unpackagedMetadata: {path: 'unpackagedMetadata'},
        }],
      };
      mockPathExists.mockResolvedValue(true);
      mockReadJson.mockResolvedValue(stagedProjectJson);

      const builder = new UnlockedPackageBuilder(mockProvider, mockSfpmPackage, baseOptions, mockLogger);
      await builder.connect(mockDevhub);
      await builder.exec();

      expect(mockWriteJson).toHaveBeenCalledWith(
        path.join(stagingDir, 'sfdx-project.json'),
        expect.objectContaining({
          packageDirectories: [expect.objectContaining({
            seedMetadata: {path: expect.stringContaining('seedMetadata')},
            unpackagedMetadata: {path: expect.stringContaining('unpackagedMetadata')},
          })],
        }),
        {spaces: 4},
      );
    });
  });
});
