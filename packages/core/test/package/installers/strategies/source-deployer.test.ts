import {
  beforeEach, describe, expect, it, vi,
} from 'vitest';

import SourceDeployer from '../../../../src/package/installers/strategies/source-deployer.js';
import {type SourceDeployable} from '../../../../src/package/installers/types.js';

const mockDeploy = vi.fn();
const mockAwaitDeploy = vi.fn();

vi.mock('../../../../src/tooling/metadata-deploy-service.js', () => {
  return {
    MetadataDeployService: class {
      awaitDeploy = mockAwaitDeploy;
      deploy = mockDeploy;
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

    beforeEach(() => {
      mockDeployable = {
        componentSet: {size: 10} as any,
        packageName: 'test-package',
        versionNumber: '1.0.0.1',
      };

      mockDeploy.mockResolvedValue('deploy123');
      mockAwaitDeploy.mockResolvedValue({
        errors: [],
        formatErrors: () => '',
        hasTestFailures: () => false,
        meetsCoverageThreshold: () => true,
        success: true,
      });
    });

    it('should successfully deploy package source', async () => {
      const result = await strategy.install(mockDeployable, 'targetOrg');

      expect(mockDeploy).toHaveBeenCalledWith(
        mockDeployable.componentSet,
        'targetOrg',
        {testLevel: undefined},
      );
      expect(mockAwaitDeploy).toHaveBeenCalledWith(
        'deploy123',
        'targetOrg',
        expect.any(Function),
      );
      expect(result.deployId).toBe('deploy123');
      expect(mockLogger.info).toHaveBeenCalledWith('Source deployment completed successfully');
    });

    it('should pass test level when provided', async () => {
      await strategy.install(mockDeployable, 'targetOrg', {testLevel: 'RunLocalTests'});

      expect(mockDeploy).toHaveBeenCalledWith(
        mockDeployable.componentSet,
        'targetOrg',
        {testLevel: 'RunLocalTests'},
      );
    });

    it('should throw error if deployment fails', async () => {
      mockAwaitDeploy.mockResolvedValue({
        errors: [{fullName: 'ApexClass.Test', problem: 'Syntax error'}],
        formatErrors: () => 'ApexClass.Test: Syntax error',
        hasTestFailures: () => false,
        meetsCoverageThreshold: () => true,
        success: false,
      });

      await expect(strategy.install(mockDeployable, 'targetOrg'))
        .rejects.toThrow('Source deployment failed:\nApexClass.Test: Syntax error');
    });

    it('should handle deployment failure with no specific errors', async () => {
      mockAwaitDeploy.mockResolvedValue({
        errors: [],
        formatErrors: () => '',
        hasTestFailures: () => false,
        meetsCoverageThreshold: () => true,
        success: false,
      });

      await expect(strategy.install(mockDeployable, 'targetOrg'))
        .rejects.toThrow('Source deployment failed:\nUnknown deployment error');
    });

    it('should emit deployment events', async () => {
      const mockEmitter = {emit: vi.fn()};
      const strategyWithEmitter = new SourceDeployer(mockLogger, mockEmitter as any);

      await strategyWithEmitter.install(mockDeployable, 'targetOrg');

      expect(mockEmitter.emit).toHaveBeenCalledWith('deployment:start', expect.objectContaining({
        packageName: 'test-package',
      }));
      expect(mockEmitter.emit).toHaveBeenCalledWith('deployment:complete', expect.objectContaining({
        packageName: 'test-package',
        success: true,
      }));
    });

    it('should emit failure event on deploy error', async () => {
      const mockEmitter = {emit: vi.fn()};
      const strategyWithEmitter = new SourceDeployer(mockLogger, mockEmitter as any);

      mockAwaitDeploy.mockResolvedValue({
        errors: [{fullName: 'X', problem: 'fail'}],
        formatErrors: () => 'X: fail',
        hasTestFailures: () => false,
        meetsCoverageThreshold: () => true,
        success: false,
      });

      await expect(strategyWithEmitter.install(mockDeployable, 'targetOrg'))
        .rejects.toThrow();

      expect(mockEmitter.emit).toHaveBeenCalledWith('deployment:complete', expect.objectContaining({
        success: false,
      }));
    });
  });
});
