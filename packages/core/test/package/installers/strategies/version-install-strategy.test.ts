import {Org} from '@salesforce/core';
import {
  beforeEach, describe, expect, it, vi,
} from 'vitest';

import VersionInstallStrategy from '../../../../src/package/installers/strategies/version-install-strategy.js';
import {SfpmSourcePackage, SfpmUnlockedPackage} from '../../../../src/package/sfpm-package.js';
import {InstallationMode, InstallationSource, PackageType} from '../../../../src/types/package.js';

// Mocks
vi.mock('@salesforce/core', async importOriginal => {
  const actual = await importOriginal<typeof import('@salesforce/core')>();
  return {
    ...actual,
    Org: {
      create: vi.fn(),
    },
  };
});

describe('VersionInstallStrategy', () => {
  let strategy: VersionInstallStrategy;
  let mockLogger: any;

  beforeEach(() => {
    mockLogger = {
      error: vi.fn(),
      info: vi.fn(),
    };
    strategy = new VersionInstallStrategy(mockLogger);
    vi.clearAllMocks();
  });

  describe('canHandle', () => {
    it('should handle unlocked packages with version ID from artifact', () => {
      const unlockedPackage = new SfpmUnlockedPackage('test-package', '/test/project');
      unlockedPackage.packageVersionId = '04t...';

      expect(strategy.canHandle(InstallationSource.Artifact, unlockedPackage)).toBe(true);
    });

    it('should not handle unlocked packages from local source (even with version ID)', () => {
      const unlockedPackage = new SfpmUnlockedPackage('test-package', '/test/project');
      unlockedPackage.packageVersionId = '04t...';

      expect(strategy.canHandle(InstallationSource.Local, unlockedPackage)).toBe(false);
    });

    it('should not handle unlocked packages without version ID', () => {
      const unlockedPackage = new SfpmUnlockedPackage('test-package', '/test/project');

      expect(strategy.canHandle(InstallationSource.Artifact, unlockedPackage)).toBe(false);
    });

    it('should not handle source packages', () => {
      const sourcePackage = new SfpmSourcePackage('test-package', '/test/project');

      expect(strategy.canHandle(InstallationSource.Artifact, sourcePackage)).toBe(false);
    });
  });

  describe('getMode', () => {
    it('should return VersionInstall mode', () => {
      expect(strategy.getMode()).toBe(InstallationMode.VersionInstall);
    });
  });

  describe('install', () => {
    let mockPackage: any;
    let mockOrg: any;
    let mockConnection: any;

    beforeEach(() => {
      mockPackage = new SfpmUnlockedPackage('test-package', '/test/project');
      mockPackage.packageVersionId = '04t1234567890';
      mockPackage.setOrchestrationOptions({installationkey: 'test-key'});

      mockConnection = {
        tooling: {
          create: vi.fn().mockResolvedValue({
            id: 'requestId123',
            success: true,
          }),
          retrieve: vi.fn(),
        },
      };

      mockOrg = {
        getConnection: vi.fn().mockReturnValue(mockConnection),
      };

      vi.mocked(Org.create).mockResolvedValue(mockOrg as any);
    });

    it('should successfully install package by version ID', async () => {
      // Mock successful polling - first call returns IN_PROGRESS, second returns SUCCESS
      mockConnection.tooling.retrieve
      .mockResolvedValueOnce({Status: 'IN_PROGRESS'})
      .mockResolvedValueOnce({Status: 'SUCCESS'});

      // Speed up the test by mocking setTimeout
      vi.useFakeTimers();
      const installPromise = strategy.install(mockPackage, 'targetOrg');

      // Fast-forward past the 5 second wait
      await vi.advanceTimersByTimeAsync(5000);
      await installPromise;
      vi.useRealTimers();

      expect(Org.create).toHaveBeenCalledWith({aliasOrUsername: 'targetOrg'});
      expect(mockConnection.tooling.create).toHaveBeenCalledWith('PackageInstallRequest', {
        ApexCompileType: 'package',
        NameConflictResolution: 'Block',
        Password: 'test-key',
        SecurityType: 'Full',
        SubscriberPackageVersionKey: '04t1234567890',
      });
      expect(mockLogger.info).toHaveBeenCalledWith('Package installation completed successfully');
    });

    it('should install without installation key if not provided', async () => {
      // Create a new package without installation key
      const packageWithoutKey = new SfpmUnlockedPackage('test-package', '/test/project');
      packageWithoutKey.packageVersionId = '04t1234567890';

      mockConnection.tooling.retrieve.mockResolvedValue({Status: 'SUCCESS'});

      await strategy.install(packageWithoutKey, 'targetOrg');

      expect(mockConnection.tooling.create).toHaveBeenCalledWith('PackageInstallRequest', {
        ApexCompileType: 'package',
        NameConflictResolution: 'Block',
        Password: '',
        SecurityType: 'Full',
        SubscriberPackageVersionKey: '04t1234567890',
      });
    });

    it('should throw error if package is not unlocked package', async () => {
      const sourcePackage = new SfpmSourcePackage('test-package', '/test/project');

      await expect(strategy.install(sourcePackage, 'targetOrg')).rejects.toThrow('Package version ID not found for: test-package');
    });

    it('should throw error if version ID is not available', async () => {
      mockPackage.packageVersionId = undefined;

      await expect(strategy.install(mockPackage, 'targetOrg')).rejects.toThrow('Package version ID not found for: test-package');
    });

    it('should throw error if connection is not available', async () => {
      mockOrg.getConnection.mockReturnValue(null);

      await expect(strategy.install(mockPackage, 'targetOrg')).rejects.toThrow('Unable to connect to org: targetOrg');
    });

    it('should throw error if install request creation fails', async () => {
      mockConnection.tooling.create.mockResolvedValue({
        errors: [{message: 'Invalid version ID'}],
        success: false,
      });

      await expect(strategy.install(mockPackage, 'targetOrg')).rejects.toThrow('Failed to create package install request');
    });

    it('should throw error if installation fails', async () => {
      mockConnection.tooling.retrieve.mockResolvedValue({
        Errors: {
          errors: [
            {message: 'Installation failed'},
            {message: 'Dependency not met'},
          ],
        },
        Status: 'ERROR',
      });

      await expect(strategy.install(mockPackage, 'targetOrg')).rejects.toThrow('Package installation failed:\nInstallation failed\nDependency not met');
    });

    it('should handle installation timeout', async () => {
      mockConnection.tooling.retrieve.mockResolvedValue({Status: 'IN_PROGRESS'});

      // Use fake timers to avoid waiting
      vi.useFakeTimers();

      const installPromise = strategy.install(mockPackage, 'targetOrg');

      // Fast-forward past the timeout
      await vi.advanceTimersByTimeAsync(600_000); // 10 minutes

      await expect(installPromise).rejects.toThrow('Package installation timed out');

      vi.useRealTimers();
    }, 15_000);

    it('should poll until success', async () => {
      mockConnection.tooling.retrieve
      .mockResolvedValueOnce({Status: 'IN_PROGRESS'})
      .mockResolvedValueOnce({Status: 'IN_PROGRESS'})
      .mockResolvedValueOnce({Status: 'IN_PROGRESS'})
      .mockResolvedValueOnce({Status: 'SUCCESS'});

      vi.useFakeTimers();
      const installPromise = strategy.install(mockPackage, 'targetOrg');

      // Fast-forward through 3 polling intervals (15 seconds total)
      await vi.advanceTimersByTimeAsync(5000);
      await vi.advanceTimersByTimeAsync(5000);
      await vi.advanceTimersByTimeAsync(5000);
      await installPromise;
      vi.useRealTimers();

      expect(mockConnection.tooling.retrieve).toHaveBeenCalledTimes(4);
    });
  });
});
