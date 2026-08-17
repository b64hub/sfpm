import {
  beforeEach, describe, expect, it, vi,
} from 'vitest';

// UnlockedPackageInstaller delegates the actual org classification and
// service work to org-utils and PackageManager, both of which have their
// own coverage elsewhere (PackageManager's PackageService is covered by
// package-service.test.ts). Mocking them here keeps this suite scoped to
// the installer's own logic: package-type guard, connect lifecycle, the
// "no packageVersionId" guard, and installation-key resolution.
const {mockGetInstance, mockManager, mockPackageService} = vi.hoisted(() => {
  const _mockPackageService = {
    installPackage: vi.fn(),
  };
  const _mockManager = {
    getPackageService: vi.fn().mockReturnValue(_mockPackageService),
    isInstalled: vi.fn(),
  };
  return {
    mockGetInstance: vi.fn().mockReturnValue(_mockManager),
    mockManager: _mockManager,
    mockPackageService: _mockPackageService,
  };
});

vi.mock('../../../src/package/package-manager.js', () => ({
  default: {getInstance: mockGetInstance},
}));

vi.mock('../../../src/utils/org-utils.js', () => ({
  resolveOrgType: vi.fn(),
}));

import UnlockedPackageInstaller from '../../../src/package/installers/unlocked-package-installer.js';
import {SfpmSourcePackage, SfpmUnlockedPackage} from '../../../src/package/sfpm-package.js';
import {resolveOrgType} from '../../../src/utils/org-utils.js';

describe('UnlockedPackageInstaller', () => {
  let mockLogger: any;
  let mockOrg: any;
  let sfpmPackage: SfpmUnlockedPackage;

  beforeEach(() => {
    vi.clearAllMocks();
    mockGetInstance.mockReturnValue(mockManager);
    mockManager.getPackageService.mockReturnValue(mockPackageService);

    mockLogger = {
      debug: vi.fn(), error: vi.fn(), info: vi.fn(), trace: vi.fn(), warn: vi.fn(),
    };
    mockOrg = {getUsername: vi.fn().mockReturnValue('target@org.com')};

    sfpmPackage = new SfpmUnlockedPackage('test-package', '/tmp/project');
    sfpmPackage.packageVersionId = '04tXXX';

    vi.mocked(resolveOrgType).mockResolvedValue('sandbox');
  });

  it('rejects a package that is not an unlocked package', () => {
    const notUnlocked = new SfpmSourcePackage('other-package', '/tmp/project');

    expect(() => new UnlockedPackageInstaller(notUnlocked as any, undefined, mockLogger))
    .toThrow(TypeError);
  });

  describe('connect', () => {
    it('throws when the org has no username', async () => {
      mockOrg.getUsername.mockReturnValue();
      const installer = new UnlockedPackageInstaller(sfpmPackage, undefined, mockLogger);

      await expect(installer.connect(mockOrg)).rejects.toThrow('Target org must have a valid username');
    });

    it('emits connectionStart with the resolved org type and connectionComplete', async () => {
      const sink: any = {connectionComplete: vi.fn(), connectionStart: vi.fn()};
      const installer = new UnlockedPackageInstaller(sfpmPackage, undefined, mockLogger, sink);

      await installer.connect(mockOrg);

      expect(sink.connectionStart).toHaveBeenCalledWith({orgType: 'sandbox', username: 'target@org.com'});
      expect(sink.connectionComplete).toHaveBeenCalledWith({username: 'target@org.com'});
    });

    it('skips connectionStart when the org type cannot be resolved, but still completes', async () => {
      vi.mocked(resolveOrgType).mockResolvedValue();
      const sink: any = {connectionComplete: vi.fn(), connectionStart: vi.fn()};
      const installer = new UnlockedPackageInstaller(sfpmPackage, undefined, mockLogger, sink);

      await installer.connect(mockOrg);

      expect(sink.connectionStart).not.toHaveBeenCalled();
      expect(sink.connectionComplete).toHaveBeenCalledWith({username: 'target@org.com'});
    });
  });

  describe('isInstalled', () => {
    it('throws when connect() has not been called', async () => {
      const installer = new UnlockedPackageInstaller(sfpmPackage, undefined, mockLogger);

      await expect(installer.isInstalled()).rejects.toThrow('Target org not connected. Call connect() before running installer.');
    });

    it('delegates to PackageManager.isInstalled with the sfpm package', async () => {
      mockManager.isInstalled.mockResolvedValue({installReason: 'hash-match', needsInstall: false});
      const installer = new UnlockedPackageInstaller(sfpmPackage, undefined, mockLogger);
      await installer.connect(mockOrg);

      const result = await installer.isInstalled();

      expect(mockGetInstance).toHaveBeenCalledWith(mockOrg);
      expect(mockManager.isInstalled).toHaveBeenCalledWith(sfpmPackage);
      expect(result).toEqual({installReason: 'hash-match', needsInstall: false});
    });
  });

  describe('run', () => {
    it('throws when connect() has not been called', async () => {
      const installer = new UnlockedPackageInstaller(sfpmPackage, undefined, mockLogger);

      await expect(installer.run()).rejects.toThrow('Target org not connected. Call connect() before running installer.');
    });

    it('throws when the package has no packageVersionId', async () => {
      const unbuiltPackage = new SfpmUnlockedPackage('unbuilt-package', '/tmp/project');
      const installer = new UnlockedPackageInstaller(unbuiltPackage, undefined, mockLogger);
      await installer.connect(mockOrg);

      await expect(installer.run()).rejects.toThrow(/unbuilt-package has no packageVersionId/);
    });

    it('installs the version with no key when none applies, and returns the install id', async () => {
      mockPackageService.installPackage.mockResolvedValue({Id: '0HfXXX'});
      const installer = new UnlockedPackageInstaller(sfpmPackage, {}, mockLogger);
      await installer.connect(mockOrg);

      const result = await installer.run();

      expect(mockPackageService.installPackage).toHaveBeenCalledWith('04tXXX', {installationKey: undefined, wait: 30});
      expect(result).toEqual({installId: '0HfXXX'});
    });

    it('resolves the wildcard installation key when the package has no explicit entry', async () => {
      mockPackageService.installPackage.mockResolvedValue({Id: '0HfXXX'});
      const options = {unlocked: {installationKeys: {'*': 'default-key'}}};
      const installer = new UnlockedPackageInstaller(sfpmPackage, options as any, mockLogger);
      await installer.connect(mockOrg);

      await installer.run();

      expect(mockPackageService.installPackage).toHaveBeenCalledWith('04tXXX', {installationKey: 'default-key', wait: 30});
    });

    it('prefers a package-specific installation key over the wildcard', async () => {
      mockPackageService.installPackage.mockResolvedValue({Id: '0HfXXX'});
      const options = {unlocked: {installationKeys: {'*': 'default-key', 'test-package': 'specific-key'}}};
      const installer = new UnlockedPackageInstaller(sfpmPackage, options as any, mockLogger);
      await installer.connect(mockOrg);

      await installer.run();

      expect(mockPackageService.installPackage).toHaveBeenCalledWith('04tXXX', {installationKey: 'specific-key', wait: 30});
    });
  });
});
