import {
  beforeEach, describe, expect, it, vi,
} from 'vitest';

// ManagedPackageInstaller delegates all real work to PackageManager/PackageService,
// which have their own dedicated coverage. Mocking PackageManager keeps this
// suite scoped to the installer's own logic: the connect lifecycle and the
// infallible isInstalled() error handling.
const {mockGetInstance, mockManager, mockPackageService} = vi.hoisted(() => {
  const _mockPackageService = {
    installPackage: vi.fn(),
    isSubscriberVersionInstalled: vi.fn(),
  };
  const _mockManager = {getPackageService: vi.fn().mockReturnValue(_mockPackageService)};
  return {
    mockGetInstance: vi.fn().mockReturnValue(_mockManager),
    mockManager: _mockManager,
    mockPackageService: _mockPackageService,
  };
});

vi.mock('../../../src/package/package-manager.js', () => ({
  default: {getInstance: mockGetInstance},
}));

import ManagedPackageInstaller from '../../../src/package/installers/managed-package-installer.js';
import {ManagedPackageRef} from '../../../src/package/installers/types.js';

describe('ManagedPackageInstaller', () => {
  let mockLogger: any;
  let mockOrg: any;
  let managedRef: ManagedPackageRef;

  beforeEach(() => {
    vi.clearAllMocks();
    mockGetInstance.mockReturnValue(mockManager);
    mockManager.getPackageService.mockReturnValue(mockPackageService);

    mockLogger = {
      debug: vi.fn(), error: vi.fn(), info: vi.fn(), trace: vi.fn(), warn: vi.fn(),
    };
    mockOrg = {getUsername: vi.fn().mockReturnValue('target@org.com')};
    managedRef = new ManagedPackageRef('nebula-logger', '04tXXX');
  });

  describe('connect', () => {
    it('emits connectionStart/connectionComplete with a hardcoded sandbox org type', async () => {
      const sink: any = {connectionComplete: vi.fn(), connectionStart: vi.fn()};
      const installer = new ManagedPackageInstaller(managedRef, undefined, mockLogger, sink);

      await installer.connect(mockOrg);

      expect(sink.connectionStart).toHaveBeenCalledWith({orgType: 'sandbox', username: 'target@org.com'});
      expect(sink.connectionComplete).toHaveBeenCalledWith({username: 'target@org.com'});
    });
  });

  describe('isInstalled', () => {
    it('reports version-installed when the subscriber version is already present', async () => {
      mockPackageService.isSubscriberVersionInstalled.mockResolvedValue(true);
      const installer = new ManagedPackageInstaller(managedRef, undefined, mockLogger);
      await installer.connect(mockOrg);

      const result = await installer.isInstalled();

      expect(mockPackageService.isSubscriberVersionInstalled).toHaveBeenCalledWith('04tXXX');
      expect(result).toEqual({installReason: 'version-installed', needsInstall: false});
      expect(mockLogger.info).toHaveBeenCalledWith(expect.stringContaining('nebula-logger'));
    });

    it('reports not-installed when the subscriber version is absent', async () => {
      mockPackageService.isSubscriberVersionInstalled.mockResolvedValue(false);
      const installer = new ManagedPackageInstaller(managedRef, undefined, mockLogger);
      await installer.connect(mockOrg);

      const result = await installer.isInstalled();

      expect(result).toEqual({installReason: 'not-installed', needsInstall: true});
    });

    it('is infallible — a check failure resolves to check-failed instead of throwing', async () => {
      mockPackageService.isSubscriberVersionInstalled.mockRejectedValue(new Error('org unreachable'));
      const installer = new ManagedPackageInstaller(managedRef, undefined, mockLogger);
      await installer.connect(mockOrg);

      const result = await installer.isInstalled();

      expect(result).toEqual({installReason: 'check-failed', needsInstall: true});
      expect(mockLogger.warn).toHaveBeenCalledWith(expect.stringContaining('nebula-logger'));
    });
  });

  describe('run', () => {
    it('installs the subscriber version and returns the install id', async () => {
      mockPackageService.installPackage.mockResolvedValue({Id: '0HfXXX'});
      const installer = new ManagedPackageInstaller(managedRef, undefined, mockLogger);
      await installer.connect(mockOrg);

      const result = await installer.run();

      expect(mockPackageService.installPackage).toHaveBeenCalledWith('04tXXX', {installationKey: undefined, wait: 30});
      expect(result).toEqual({installId: '0HfXXX'});
    });

    it('forwards an installation key when present on the managed ref', async () => {
      mockPackageService.installPackage.mockResolvedValue({Id: '0HfXXX'});
      (managedRef as any).installationKey = 'subscriber-key';
      const installer = new ManagedPackageInstaller(managedRef, undefined, mockLogger);
      await installer.connect(mockOrg);

      await installer.run();

      expect(mockPackageService.installPackage).toHaveBeenCalledWith('04tXXX', {installationKey: 'subscriber-key', wait: 30});
    });
  });
});
