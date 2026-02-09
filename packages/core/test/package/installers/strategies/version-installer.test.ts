import {Org} from '@salesforce/core';
import {
  beforeEach, describe, expect, it, vi,
} from 'vitest';

import VersionInstaller from '../../../../src/package/installers/strategies/version-installer.js';
import {type VersionInstallable} from '../../../../src/package/installers/types.js';

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

describe('VersionInstaller', () => {
  let strategy: VersionInstaller;
  let mockLogger: any;

  beforeEach(() => {
    mockLogger = {
      error: vi.fn(),
      info: vi.fn(),
    };
    strategy = new VersionInstaller(mockLogger);
    vi.clearAllMocks();
  });

  describe('install', () => {
    let mockInstallable: VersionInstallable;
    let mockOrg: any;
    let mockConnection: any;

    beforeEach(() => {
      mockInstallable = {
        installationKey: 'test-key',
        packageName: 'test-package',
        packageVersionId: '04t1234567890',
        versionNumber: '1.0.0.1',
      };

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
      const installPromise = strategy.install(mockInstallable, 'targetOrg');

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
      const installableWithoutKey: VersionInstallable = {
        packageName: 'test-package',
        packageVersionId: '04t1234567890',
      };

      mockConnection.tooling.retrieve.mockResolvedValue({Status: 'SUCCESS'});

      await strategy.install(installableWithoutKey, 'targetOrg');

      expect(mockConnection.tooling.create).toHaveBeenCalledWith('PackageInstallRequest', {
        ApexCompileType: 'package',
        NameConflictResolution: 'Block',
        Password: '',
        SecurityType: 'Full',
        SubscriberPackageVersionKey: '04t1234567890',
      });
    });

    it('should throw error if version ID is not available', async () => {
      const installableWithoutVersion: VersionInstallable = {
        packageName: 'test-package',
        packageVersionId: '',
      };

      await expect(strategy.install(installableWithoutVersion, 'targetOrg')).rejects.toThrow('Package version ID not found for: test-package');
    });

    it('should throw error if connection is not available', async () => {
      mockOrg.getConnection.mockReturnValue(null);

      await expect(strategy.install(mockInstallable, 'targetOrg')).rejects.toThrow('Unable to connect to org: targetOrg');
    });

    it('should throw error if install request creation fails', async () => {
      mockConnection.tooling.create.mockResolvedValue({
        errors: [{message: 'Invalid version ID'}],
        success: false,
      });

      await expect(strategy.install(mockInstallable, 'targetOrg')).rejects.toThrow('Failed to create package install request');
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

      await expect(strategy.install(mockInstallable, 'targetOrg')).rejects.toThrow('Package installation failed:\nInstallation failed\nDependency not met');
    });

    it('should handle installation timeout', async () => {
      mockConnection.tooling.retrieve.mockResolvedValue({Status: 'IN_PROGRESS'});

      // Use fake timers to avoid waiting
      vi.useFakeTimers();

      const installPromise = strategy.install(mockInstallable, 'targetOrg');

      // Fast-forward past the timeout, then assert — order matters to avoid
      // an unhandled rejection: attach the rejection handler first.
      const assertion = expect(installPromise).rejects.toThrow('Package installation timed out');
      await vi.advanceTimersByTimeAsync(600_000); // 10 minutes
      await assertion;

      vi.useRealTimers();
    }, 15_000);

    it('should poll until success', async () => {
      mockConnection.tooling.retrieve
      .mockResolvedValueOnce({Status: 'IN_PROGRESS'})
      .mockResolvedValueOnce({Status: 'IN_PROGRESS'})
      .mockResolvedValueOnce({Status: 'IN_PROGRESS'})
      .mockResolvedValueOnce({Status: 'SUCCESS'});

      vi.useFakeTimers();
      const installPromise = strategy.install(mockInstallable, 'targetOrg');

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
