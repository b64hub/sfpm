import {beforeEach, describe, expect, it, vi} from 'vitest';

import {ApexTestPollingStrategy} from '../../../src/watcher/strategies/apex-test-strategy.js';

vi.mock('@salesforce/core');

const mockCheckRunStatus = vi.fn();
const mockReportAsyncResults = vi.fn();

vi.mock('@salesforce/apex-node', () => ({
  TestService: class MockTestService {
    asyncService = {checkRunStatus: mockCheckRunStatus};
    reportAsyncResults = mockReportAsyncResults;
  },
}));

describe('ApexTestPollingStrategy', () => {
  let strategy: ApexTestPollingStrategy;
  let mockConnection: any;

  beforeEach(() => {
    vi.clearAllMocks();
    strategy = new ApexTestPollingStrategy();
    mockConnection = {};
  });

  it('should have correct defaults', () => {
    expect(strategy.jobType).toBe('test');
    expect(strategy.defaultIntervalMs).toBe(10_000);
    expect(strategy.defaultTimeoutMs).toBe(3_600_000);
  });

  describe('poll', () => {
    it('should return pending when tests are still running', async () => {
      mockCheckRunStatus.mockResolvedValue({
        testsComplete: false,
        testRunSummary: {
          ClassesCompleted: 3,
          ClassesEnqueued: 10,
          Status: 'Processing',
        },
      });

      const result = await strategy.poll(mockConnection, {testRunId: '707XXX'});

      expect(result.status).toBe('pending');
      if (result.status === 'pending') {
        expect(result.message).toContain('3/10');
      }
    });

    it('should return completed when all tests pass', async () => {
      mockCheckRunStatus.mockResolvedValue({
        testsComplete: true,
        testRunSummary: {
          ClassesCompleted: 5,
          ClassesEnqueued: 5,
          Status: 'Completed',
        },
      });
      mockReportAsyncResults.mockResolvedValue({
        summary: {failing: 0, passing: 20, testsRan: 20},
        tests: [],
      });

      const result = await strategy.poll(mockConnection, {testRunId: '707XXX'});

      expect(result.status).toBe('completed');
      if (result.status === 'completed') {
        expect(result.result.methodsPassed).toBe(20);
        expect(result.result.methodsFailed).toBe(0);
      }
    });

    it('should return failed when tests have failures', async () => {
      mockCheckRunStatus.mockResolvedValue({
        testsComplete: true,
        testRunSummary: {
          ClassesCompleted: 5,
          ClassesEnqueued: 5,
          Status: 'Completed',
        },
      });
      mockReportAsyncResults.mockResolvedValue({
        summary: {failing: 3, passing: 17, testsRan: 20},
        tests: [],
      });

      const result = await strategy.poll(mockConnection, {testRunId: '707XXX'});

      expect(result.status).toBe('failed');
      if (result.status === 'failed') {
        expect(result.error).toContain('3 test methods failed');
        expect(result.result.methodsFailed).toBe(3);
        expect(result.result.methodsPassed).toBe(17);
      }
    });

    it('should return failed when test run is aborted', async () => {
      mockCheckRunStatus.mockResolvedValue({
        testsComplete: true,
        testRunSummary: {
          ClassesCompleted: 2,
          ClassesEnqueued: 5,
          Status: 'Aborted',
        },
      });
      mockReportAsyncResults.mockResolvedValue({
        summary: {failing: 0, passing: 8, testsRan: 8},
        tests: [],
      });

      const result = await strategy.poll(mockConnection, {testRunId: '707XXX'});

      expect(result.status).toBe('failed');
      if (result.status === 'failed') {
        expect(result.error).toContain('Aborted');
      }
    });
  });
});
