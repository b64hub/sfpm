import {beforeEach, describe, expect, it, vi} from 'vitest';

import {DeployPollingStrategy} from '../../../src/watcher/strategies/deploy-strategy.js';

vi.mock('@salesforce/core');

describe('DeployPollingStrategy', () => {
  let strategy: DeployPollingStrategy;
  let mockConnection: any;

  beforeEach(() => {
    vi.clearAllMocks();
    strategy = new DeployPollingStrategy();
    mockConnection = {
      metadata: {
        checkDeployStatus: vi.fn(),
      },
    };
  });

  it('should have correct defaults', () => {
    expect(strategy.jobType).toBe('deploy');
    expect(strategy.defaultIntervalMs).toBe(5_000);
    expect(strategy.defaultTimeoutMs).toBe(1_800_000);
  });

  describe('poll', () => {
    it('should return pending when deploy is not done', async () => {
      mockConnection.metadata.checkDeployStatus.mockResolvedValue({
        done: false,
        numberComponentsDeployed: 5,
        numberComponentsTotal: 20,
        status: 'InProgress',
      });

      const result = await strategy.poll(mockConnection, {deployId: '0Af123'});

      expect(result.status).toBe('pending');
      if (result.status === 'pending') {
        expect(result.message).toContain('5/20');
      }
    });

    it('should return completed when deploy succeeds', async () => {
      mockConnection.metadata.checkDeployStatus.mockResolvedValue({
        details: {},
        done: true,
        numberComponentsDeployed: 20,
        numberComponentsTotal: 20,
        status: 'Succeeded',
        success: true,
      });

      const result = await strategy.poll(mockConnection, {deployId: '0Af123'});

      expect(result.status).toBe('completed');
      if (result.status === 'completed') {
        expect(result.result.componentsDeployed).toBe(20);
        expect(result.result.status).toBe('Succeeded');
      }
    });

    it('should return failed when deploy fails with component errors', async () => {
      mockConnection.metadata.checkDeployStatus.mockResolvedValue({
        details: {
          componentFailures: [
            {fullName: 'MyClass', problem: 'Compilation error'},
          ],
        },
        done: true,
        numberComponentsDeployed: 15,
        numberComponentsTotal: 20,
        status: 'Failed',
        success: false,
      });

      const result = await strategy.poll(mockConnection, {deployId: '0Af123'});

      expect(result.status).toBe('failed');
      if (result.status === 'failed') {
        expect(result.error).toContain('component error');
        expect(result.result.componentErrors).toBe(1);
      }
    });

    it('should include test results when available', async () => {
      mockConnection.metadata.checkDeployStatus.mockResolvedValue({
        details: {
          runTestResult: {
            numFailures: 2,
            numTestsRun: 10,
          },
        },
        done: true,
        numberComponentsDeployed: 20,
        numberComponentsTotal: 20,
        status: 'Failed',
        success: false,
      });

      const result = await strategy.poll(mockConnection, {deployId: '0Af123'});

      expect(result.status).toBe('failed');
      if (result.status === 'failed') {
        expect(result.result.testsTotal).toBe(10);
        expect(result.result.testsFailed).toBe(2);
        expect(result.error).toContain('test failure');
      }
    });
  });
});
