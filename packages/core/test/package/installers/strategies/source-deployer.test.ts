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
});
