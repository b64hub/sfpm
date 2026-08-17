import {
  beforeEach, describe, expect, it, vi,
} from 'vitest';

// SourcePackageInstaller delegates the actual deployment to MetadataDeployService
// and the installed-check to PackageManager — both covered elsewhere. Mocking
// them keeps this suite scoped to the installer's own logic: connect lifecycle,
// org-alias resolution, deploy option/progress wiring, and success/failure
// result shaping (including the AggregateError formatting on failure).
const {mockDeployService, mockGetInstance, mockManager} = vi.hoisted(() => {
  const _mockDeployService = {
    awaitDeploy: vi.fn(),
    deploy: vi.fn(),
  };
  const _mockManager = {isInstalled: vi.fn()};
  return {
    mockDeployService: _mockDeployService,
    mockGetInstance: vi.fn().mockReturnValue(_mockManager),
    mockManager: _mockManager,
  };
});

vi.mock('../../../src/tooling/metadata-deploy-service.js', () => ({
  MetadataDeployService: function MetadataDeployService() {
    return mockDeployService;
  },
}));

vi.mock('../../../src/package/package-manager.js', () => ({
  default: {getInstance: mockGetInstance},
}));

vi.mock('../../../src/utils/org-utils.js', () => ({
  resolveOrgType: vi.fn(),
}));

import SourcePackageInstaller from '../../../src/package/installers/source-package-installer.js';
import {SfpmSourcePackage} from '../../../src/package/sfpm-package.js';
import {resolveOrgType} from '../../../src/utils/org-utils.js';

function makeSink(): any {
  return {
    connectionComplete: vi.fn(),
    connectionStart: vi.fn(),
    deployComplete: vi.fn(),
    deployProgress: vi.fn(),
    deployStart: vi.fn(),
  };
}

describe('SourcePackageInstaller', () => {
  let mockLogger: any;
  let mockOrg: any;
  let sfpmPackage: SfpmSourcePackage;
  let fakeComponentSet: any;

  beforeEach(() => {
    vi.clearAllMocks();
    mockGetInstance.mockReturnValue(mockManager);

    mockLogger = {
      debug: vi.fn(), error: vi.fn(), info: vi.fn(), trace: vi.fn(), warn: vi.fn(),
    };
    mockOrg = {getUsername: vi.fn().mockReturnValue('target@org.com')};

    sfpmPackage = new SfpmSourcePackage('test-package', '/tmp/project');
    fakeComponentSet = {size: 3};
    // The real componentSet getter resolves a filesystem path via
    // packageDirectory before checking its own cache, which throws without a
    // packageDefinition. Spying the getter directly is the clean seam —
    // ComponentSet resolution itself belongs to sfpm-package.test.ts, not here.
    vi.spyOn(sfpmPackage, 'componentSet', 'get').mockReturnValue(fakeComponentSet);

    vi.mocked(resolveOrgType).mockResolvedValue('sandbox');
    mockDeployService.deploy.mockResolvedValue('0Af000000001');
  });

  describe('connect', () => {
    it('throws when the org has no username', async () => {
      mockOrg.getUsername.mockReturnValue();
      const installer = new SourcePackageInstaller(sfpmPackage, undefined, mockLogger);

      await expect(installer.connect(mockOrg)).rejects.toThrow('Target org must have a valid username');
    });

    it('emits connectionStart with the resolved org type and connectionComplete', async () => {
      const sink: any = {connectionComplete: vi.fn(), connectionStart: vi.fn()};
      const installer = new SourcePackageInstaller(sfpmPackage, undefined, mockLogger, sink);

      await installer.connect(mockOrg);

      expect(sink.connectionStart).toHaveBeenCalledWith({orgType: 'sandbox', username: 'target@org.com'});
      expect(sink.connectionComplete).toHaveBeenCalledWith({username: 'target@org.com'});
    });
  });

  describe('isInstalled', () => {
    it('throws when connect() has not been called', async () => {
      const installer = new SourcePackageInstaller(sfpmPackage, undefined, mockLogger);

      await expect(installer.isInstalled()).rejects.toThrow('Ensure to conect to target org before runnnig installer');
    });

    it('delegates to PackageManager.isInstalled with the sfpm package', async () => {
      mockManager.isInstalled.mockResolvedValue({installReason: 'hash-match', needsInstall: false});
      const installer = new SourcePackageInstaller(sfpmPackage, undefined, mockLogger);
      await installer.connect(mockOrg);

      const result = await installer.isInstalled();

      expect(mockGetInstance).toHaveBeenCalledWith(mockOrg);
      expect(mockManager.isInstalled).toHaveBeenCalledWith(sfpmPackage);
      expect(result).toEqual({installReason: 'hash-match', needsInstall: false});
    });
  });

  describe('run', () => {
    it('throws when connect() has not been called', async () => {
      const installer = new SourcePackageInstaller(sfpmPackage, undefined, mockLogger);

      await expect(installer.run()).rejects.toThrow('Ensure to conect to target org before runnnig installer');
    });

    it('deploys the component set with the configured test level', async () => {
      mockDeployService.awaitDeploy.mockResolvedValue({
        deployed: 3, errors: [], success: true, total: 3,
      });
      const installer = new SourcePackageInstaller(sfpmPackage, {testLevel: 'RunLocalTests'}, mockLogger);
      await installer.connect(mockOrg);

      await installer.run();

      expect(mockDeployService.deploy).toHaveBeenCalledWith(fakeComponentSet, {testLevel: 'RunLocalTests'});
    });

    it('returns the deploy id and emits deployStart/deployComplete on success', async () => {
      mockDeployService.awaitDeploy.mockResolvedValue({
        deployed: 3, errors: [], success: true, total: 3,
      });
      const sink = makeSink();
      const installer = new SourcePackageInstaller(sfpmPackage, undefined, mockLogger, sink);
      await installer.connect(mockOrg);

      const result = await installer.run();

      expect(result).toEqual({installId: '0Af000000001'});
      expect(sink.deployStart).toHaveBeenCalledWith({targetOrg: 'target@org.com'});
      expect(sink.deployComplete).toHaveBeenCalledWith({targetOrg: 'target@org.com'});
      expect(mockLogger.debug).toHaveBeenCalledWith(expect.stringContaining('completed successfully'));
    });

    it('forwards deploy progress to the sink', async () => {
      mockDeployService.awaitDeploy.mockImplementation(async (_id: string, onProgress: (p: any) => void) => {
        onProgress({
          deployed: 1, percentage: 33, status: 'InProgress', total: 3,
        });
        return {
          deployed: 3, errors: [], success: true, total: 3,
        };
      });
      const sink = makeSink();
      const installer = new SourcePackageInstaller(sfpmPackage, undefined, mockLogger, sink);
      await installer.connect(mockOrg);

      await installer.run();

      expect(sink.deployProgress).toHaveBeenCalledWith({status: 'InProgress'});
    });

    it('throws an AggregateError with per-component details when the deploy fails', async () => {
      mockDeployService.awaitDeploy.mockResolvedValue({
        deployed: 1,
        errors: [
          {fullName: 'MyClass', problem: 'Compile error'},
          {fullName: 'MyClass2', problem: 'Missing field'},
        ],
        success: false,
        total: 3,
      });
      const installer = new SourcePackageInstaller(sfpmPackage, undefined, mockLogger);
      await installer.connect(mockOrg);

      const error = await installer.run().catch((error_: AggregateError) => error_);

      expect(error).toBeInstanceOf(AggregateError);
      expect((error as AggregateError).message).toBe('Source deployment failed (2 components)');
      expect([...(error as AggregateError).errors]).toEqual([
        {label: 'MyClass', message: 'Compile error'},
        {label: 'MyClass2', message: 'Missing field'},
      ]);
    });

    it('uses singular component wording for a single-component failure', async () => {
      mockDeployService.awaitDeploy.mockResolvedValue({
        deployed: 0, errors: [{fullName: 'MyClass', problem: 'Compile error'}], success: false, total: 1,
      });
      const installer = new SourcePackageInstaller(sfpmPackage, undefined, mockLogger);
      await installer.connect(mockOrg);

      const error = await installer.run().catch((error_: AggregateError) => error_);

      expect((error as AggregateError).message).toBe('Source deployment failed (1 component)');
    });

    it('throws a plain error when the deploy fails with no component-level detail', async () => {
      mockDeployService.awaitDeploy.mockResolvedValue({
        deployed: 0, errors: [], success: false, total: 0,
      });
      const installer = new SourcePackageInstaller(sfpmPackage, undefined, mockLogger);
      await installer.connect(mockOrg);

      await expect(installer.run()).rejects.toThrow('Unknown deployment error');
    });

    it('does not resolve an org alias for a package that is not org-aliased', async () => {
      mockDeployService.awaitDeploy.mockResolvedValue({
        deployed: 3, errors: [], success: true, total: 3,
      });
      const resolveOrgAliasSpy = vi.spyOn(sfpmPackage, 'resolveOrgAlias');
      const installer = new SourcePackageInstaller(sfpmPackage, undefined, mockLogger);
      await installer.connect(mockOrg);

      await installer.run();

      expect(resolveOrgAliasSpy).not.toHaveBeenCalled();
    });

    it('resolves the org alias before deploying when the package is org-aliased', async () => {
      mockDeployService.awaitDeploy.mockResolvedValue({
        deployed: 3, errors: [], success: true, total: 3,
      });
      vi.spyOn(sfpmPackage, 'isOrgAliased', 'get').mockReturnValue(true);
      const resolveOrgAliasSpy = vi.spyOn(sfpmPackage, 'resolveOrgAlias').mockResolvedValue({} as any);
      const installer = new SourcePackageInstaller(sfpmPackage, undefined, mockLogger);
      await installer.connect(mockOrg);

      await installer.run();

      expect(resolveOrgAliasSpy).toHaveBeenCalledWith('target@org.com');
    });
  });
});
