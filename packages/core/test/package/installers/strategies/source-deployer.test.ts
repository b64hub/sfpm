import {Org} from '@salesforce/core';
import {
  beforeEach, describe, expect, it, vi,
} from 'vitest';

import SourceDeployer from '../../../../src/package/installers/strategies/source-deployer.js';
import {type SourceDeployable} from '../../../../src/package/installers/types.js';

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

describe('SourceDeployer', () => {
  let strategy: SourceDeployer;
  let mockLogger: any;

  beforeEach(() => {
    mockLogger = {
      debug: vi.fn(),
      error: vi.fn(),
      info: vi.fn(),
    };
    strategy = new SourceDeployer(mockLogger);
    vi.clearAllMocks();
  });

  describe('install', () => {
    let mockDeployable: SourceDeployable;
    let mockOrg: any;
    let mockConnection: any;
    let mockDeploy: any;
    let mockComponentSet: any;

    beforeEach(() => {
      mockDeploy = {
        id: 'deploy123',
        onUpdate: vi.fn(),
        pollStatus: vi.fn().mockResolvedValue({
          response: {
            details: {},
            success: true,
          },
        }),
      };

      mockComponentSet = {
        deploy: vi.fn().mockResolvedValue(mockDeploy),
        size: 10,
      };

      mockDeployable = {
        componentSet: mockComponentSet as any,
        packageName: 'test-package',
        versionNumber: '1.0.0.1',
      };

      mockConnection = {
        tooling: {},
      };

      mockOrg = {
        getConnection: vi.fn().mockReturnValue(mockConnection),
      };

      vi.mocked(Org.create).mockResolvedValue(mockOrg as any);
    });

    it('should successfully deploy package source', async () => {
      await strategy.install(mockDeployable, 'targetOrg');

      expect(Org.create).toHaveBeenCalledWith({aliasOrUsername: 'targetOrg'});
      expect(mockComponentSet.deploy).toHaveBeenCalledWith({
        usernameOrConnection: mockConnection,
      });
      expect(mockDeploy.pollStatus).toHaveBeenCalled();
      expect(mockLogger.info).toHaveBeenCalledWith('Source deployment completed successfully');
    });

    it('should throw error if connection is not available', async () => {
      mockOrg.getConnection.mockReturnValue(null);

      await expect(strategy.install(mockDeployable, 'targetOrg')).rejects.toThrow('Unable to connect to org: targetOrg');
    });

    it('should throw error if deployment fails', async () => {
      mockDeploy.pollStatus.mockResolvedValue({
        response: {
          details: {
            componentFailures: [
              {fullName: 'ApexClass.Test', problem: 'Syntax error'},
            ],
          },
          success: false,
        },
      });

      await expect(strategy.install(mockDeployable, 'targetOrg')).rejects.toThrow('Source deployment failed:\nApexClass.Test: Syntax error');
    });

    it('should handle single failure object', async () => {
      mockDeploy.pollStatus.mockResolvedValue({
        response: {
          details: {
            componentFailures: {fullName: 'ApexClass.Test', problem: 'Error'},
          },
          success: false,
        },
      });

      await expect(strategy.install(mockDeployable, 'targetOrg')).rejects.toThrow('Source deployment failed:\nApexClass.Test: Error');
    });

    it('should handle deployment failure with no specific errors', async () => {
      mockDeploy.pollStatus.mockResolvedValue({
        response: {
          details: {},
          success: false,
        },
      });

      await expect(strategy.install(mockDeployable, 'targetOrg')).rejects.toThrow('Source deployment failed:\nUnknown deployment error');
    });
  });

  describe('handleDeployFailure', () => {
    let mockDeployable: SourceDeployable;
    let mockOrg: any;
    let mockConnection: any;
    let mockDeploy: any;
    let mockComponentSet: any;

    beforeEach(() => {
      mockDeploy = {
        id: 'deploy123',
        onUpdate: vi.fn(),
        pollStatus: vi.fn(),
      };

      mockComponentSet = {
        deploy: vi.fn().mockResolvedValue(mockDeploy),
        size: 10,
      };

      mockDeployable = {
        componentSet: mockComponentSet as any,
        packageName: 'test-package',
        versionNumber: '1.0.0.1',
      };

      mockConnection = {
        metadata: {
          checkDeployStatus: vi.fn(),
        },
      };

      mockOrg = {
        getConnection: vi.fn().mockReturnValue(mockConnection),
      };

      vi.mocked(Org.create).mockResolvedValue(mockOrg as any);
    });

    it('should recover when server-side deploy succeeded despite client error', async () => {
      mockDeploy.pollStatus.mockRejectedValue(new Error('socket hang up'));
      mockConnection.metadata.checkDeployStatus.mockResolvedValue({
        done: true,
        success: true,
      });

      const result = await strategy.install(mockDeployable, 'targetOrg');

      expect(result.deployId).toBe('deploy123');
      expect(mockLogger.info).toHaveBeenCalledWith(
        expect.stringContaining('succeeded server-side'),
      );
    });

    it('should throw with component errors when server-side deploy failed', async () => {
      mockDeploy.pollStatus.mockRejectedValue(new Error('socket hang up'));
      mockConnection.metadata.checkDeployStatus.mockResolvedValue({
        details: {
          componentFailures: [{fullName: 'MyClass', problem: 'Compile error'}],
        },
        done: true,
        success: false,
      });

      await expect(strategy.install(mockDeployable, 'targetOrg'))
        .rejects.toThrow('Source deployment failed:\nMyClass: Compile error');
    });

    it('should throw with deploy ID when deployment is still in progress', async () => {
      mockDeploy.pollStatus.mockRejectedValue(new Error('socket hang up'));
      mockConnection.metadata.checkDeployStatus.mockResolvedValue({
        done: false,
        status: 'InProgress',
        success: false,
      });

      const error = await strategy.install(mockDeployable, 'targetOrg').catch((e: Error) => e);
      expect(error).toBeInstanceOf(Error);
      expect(error!.message).toContain('still in progress');
      expect(error!.message).toContain('deploy123');
    });

    it('should throw original error when verify query also fails', async () => {
      mockDeploy.pollStatus.mockRejectedValue(new Error('socket hang up'));
      mockConnection.metadata.checkDeployStatus.mockRejectedValue(
        new Error('connection refused'),
      );

      await expect(strategy.install(mockDeployable, 'targetOrg'))
        .rejects.toThrow('socket hang up');
    });
  });
});
