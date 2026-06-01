import {beforeEach, describe, expect, it, vi} from 'vitest';

import {BuildPollingStrategy} from '../../../src/watcher/strategies/build-strategy.js';

vi.mock('@salesforce/core');
vi.mock('@salesforce/packaging');

describe('BuildPollingStrategy', () => {
  let strategy: BuildPollingStrategy;
  let mockConnection: any;

  beforeEach(() => {
    vi.clearAllMocks();
    strategy = new BuildPollingStrategy();
    mockConnection = {};
  });

  it('should have correct defaults', () => {
    expect(strategy.jobType).toBe('build');
    expect(strategy.defaultIntervalMs).toBe(30_000);
    expect(strategy.defaultTimeoutMs).toBe(7_200_000);
  });

  describe('connect', () => {
    it('should create org connection from auth', async () => {
      const {Org} = await import('@salesforce/core');
      const mockOrg = {getConnection: vi.fn().mockReturnValue(mockConnection)};
      vi.mocked(Org.create).mockResolvedValue(mockOrg as any);

      const conn = await strategy.connect({username: 'user@example.com'});

      expect(Org.create).toHaveBeenCalledWith({aliasOrUsername: 'user@example.com'});
      expect(conn).toBe(mockConnection);
    });
  });

  describe('poll', () => {
    it('should return completed when all targets succeed', async () => {
      const {PackageVersion} = await import('@salesforce/packaging');
      vi.mocked(PackageVersion.getCreateStatus).mockResolvedValue({
        CodeCoverage: 85,
        HasPassedCodeCoverageCheck: true,
        Status: 'Success',
        SubscriberPackageVersionId: '04tXXXXXXXXXXXXXXX',
      } as any);

      const result = await strategy.poll(mockConnection, {
        targets: [{packageName: 'my-pkg', packageVersionCreateRequestId: '08cXXX'}],
      });

      expect(result.status).toBe('completed');
      if (result.status === 'completed') {
        expect(result.result.packages).toHaveLength(1);
        expect(result.result.packages[0].codeCoverage).toBe(85);
        expect(result.result.packages[0].status).toBe('Success');
      }
    });

    it('should return pending when targets are in progress', async () => {
      const {PackageVersion} = await import('@salesforce/packaging');
      vi.mocked(PackageVersion.getCreateStatus).mockResolvedValue({
        Status: 'InProgress',
      } as any);

      const result = await strategy.poll(mockConnection, {
        targets: [{packageName: 'my-pkg', packageVersionCreateRequestId: '08cXXX'}],
      });

      expect(result.status).toBe('pending');
      if (result.status === 'pending') {
        expect(result.message).toContain('0/1');
      }
    });

    it('should return failed when a target errors', async () => {
      const {PackageVersion} = await import('@salesforce/packaging');
      vi.mocked(PackageVersion.getCreateStatus).mockResolvedValue({
        Error: ['Apex compile error'],
        Status: 'Error',
        SubscriberPackageVersionId: '04tXXX',
      } as any);

      const result = await strategy.poll(mockConnection, {
        targets: [{packageName: 'my-pkg', packageVersionCreateRequestId: '08cXXX'}],
      });

      expect(result.status).toBe('failed');
      if (result.status === 'failed') {
        expect(result.error).toContain('my-pkg');
        expect(result.result.packages[0].error).toContain('Apex compile error');
      }
    });

    it('should return failed when creation request is not found', async () => {
      const {PackageVersion} = await import('@salesforce/packaging');
      vi.mocked(PackageVersion.getCreateStatus).mockResolvedValue(null as any);

      const result = await strategy.poll(mockConnection, {
        targets: [{packageName: 'my-pkg', packageVersionCreateRequestId: '08cXXX'}],
      });

      expect(result.status).toBe('failed');
    });

    it('should handle multiple targets with mixed statuses', async () => {
      const {PackageVersion} = await import('@salesforce/packaging');
      vi.mocked(PackageVersion.getCreateStatus)
        .mockResolvedValueOnce({Status: 'Success', CodeCoverage: 90} as any)
        .mockResolvedValueOnce({Status: 'InProgress'} as any);

      const result = await strategy.poll(mockConnection, {
        targets: [
          {packageName: 'pkg-a', packageVersionCreateRequestId: '08c-a'},
          {packageName: 'pkg-b', packageVersionCreateRequestId: '08c-b'},
        ],
      });

      expect(result.status).toBe('pending');
      if (result.status === 'pending') {
        expect(result.message).toContain('1/2');
      }
    });
  });
});
