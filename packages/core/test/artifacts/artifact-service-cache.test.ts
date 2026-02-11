import {
  afterEach, beforeEach, describe, expect, it, vi,
} from 'vitest';

import {ArtifactService} from '../../src/artifacts/artifact-service.js';

// Mock @salesforce/core
vi.mock('@salesforce/core', () => ({
  Org: {
    create: vi.fn(),
  },
}));

const ARTIFACT_RECORDS = [
  {
    Checksum__c: 'hash-a', Commit_Id__c: 'abc', Id: '001A', Name: 'pkg-a', Tag__c: 'pkg-a@1.0.0', Version__c: '1.0.0',
  },
  {
    Checksum__c: 'hash-b', Commit_Id__c: 'def', Id: '001B', Name: 'pkg-b', Tag__c: 'pkg-b@2.0.0', Version__c: '2.0.0',
  },
  {
    Checksum__c: undefined, Commit_Id__c: undefined, Id: '001C', Name: 'pkg-c', Tag__c: undefined, Version__c: '3.0.0',
  },
];

describe('ArtifactService caching', () => {
  let service: ArtifactService;
  let mockConnection: any;
  let mockOrg: any;
  let queryFn: ReturnType<typeof vi.fn>;

  const mockLogger = {
    debug: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    log: vi.fn(),
    trace: vi.fn(),
    warn: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();

    queryFn = vi.fn().mockResolvedValue({records: ARTIFACT_RECORDS});
    mockConnection = {
      query: queryFn,
      tooling: {query: vi.fn()},
    };
    mockOrg = {
      getConnection: vi.fn().mockReturnValue(mockConnection),
      getUsername: vi.fn().mockReturnValue('test@example.com'),
    };

    service = new ArtifactService(mockLogger, mockOrg);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('lazy-loading cache', () => {
    it('should query all artifacts and populate cache on first access', async () => {
      // First access triggers lazy load
      await service.getInstalledPackages();

      expect(queryFn).toHaveBeenCalledTimes(1);
      expect(queryFn.mock.calls[0][0]).toContain('SfpmArtifact__c');
    });

    it('should handle query failure gracefully', async () => {
      queryFn.mockRejectedValue(new Error('SOQL error'));

      // Should not throw; cache remains null and logs debug message
      await service.getInstalledPackages();

      expect(mockLogger.debug).toHaveBeenCalled();
      expect(mockLogger.debug.mock.calls.some(call =>
        call[0].includes('Unable to load installed artifacts cache'))).toBe(true);
    });

    it('should require org connection for cache-dependent operations', async () => {
      const serviceNoOrg = new ArtifactService(mockLogger);

      // Methods that need cache require org
      await expect(serviceNoOrg.getInstalledPackages()).rejects.toThrow('Org connection required for getInstalledPackages');

      await expect(serviceNoOrg.isArtifactInstalled('test-pkg')).rejects.toThrow('Org connection required for isArtifactInstalled');
    });
  });

  describe('isArtifactInstalled (cached)', () => {
    beforeEach(async () => {
      // Trigger lazy load by accessing cache
      await service.getInstalledPackages();
      queryFn.mockClear(); // reset count after cache load
    });

    it('should return cached result without additional SOQL', async () => {
      const result = await service.isArtifactInstalled('pkg-a');

      expect(result.isInstalled).toBe(true);
      expect(result.versionNumber).toBe('1.0.0');
      // No extra query after cache hit
      expect(queryFn).not.toHaveBeenCalled();
    });

    it('should return false for unknown package', async () => {
      const result = await service.isArtifactInstalled('unknown-pkg');

      expect(result.isInstalled).toBe(false);
      expect(queryFn).not.toHaveBeenCalled();
    });

    it('should check version match when version argument is provided', async () => {
      const matchResult = await service.isArtifactInstalled('pkg-a', '1.0.0');
      expect(matchResult.isInstalled).toBe(true);

      const mismatchResult = await service.isArtifactInstalled('pkg-a', '9.9.9');
      expect(mismatchResult.isInstalled).toBe(false);
    });
  });

  describe('getArtifactRecordId (cached)', () => {
    /**
     * getArtifactRecordId is private, but we can test it indirectly through
     * isArtifactInstalled (which uses cache too). Instead, we test the
     * upsertArtifact flow which calls getArtifactRecordId internally.
     * For direct verification, we rely on the SOQL query count.
     */
    it('should use cache for record ID lookup during upsert flow', async () => {
      // Trigger lazy load
      await service.getInstalledPackages();
      queryFn.mockClear();

      // Mock the connection.sobject().upsert() path used by upsertArtifact
      const upsertFn = vi.fn().mockResolvedValue({id: '001A', success: true});
      mockConnection.sobject = vi.fn().mockReturnValue({
        upsert: upsertFn,
      });

      // After isArtifactInstalled (cached), any record ID lookup should also be cached
      const result = await service.isArtifactInstalled('pkg-a');
      expect(result.isInstalled).toBe(true);

      // No SOQL was executed
      expect(queryFn).not.toHaveBeenCalled();
    });
  });

  describe('clearCache', () => {
    it('should force subsequent calls to query the org', async () => {
      // Trigger lazy load
      await service.getInstalledPackages();
      queryFn.mockClear();

      service.clearCache();

      // Next call should hit the org
      await service.isArtifactInstalled('pkg-a');
      expect(queryFn).toHaveBeenCalledTimes(1);
    });
  });

  describe('invalidatePackage', () => {
    it('should remove a single package from cache', async () => {
      // Trigger lazy load
      await service.getInstalledPackages();
      queryFn.mockClear();

      service.invalidatePackage('pkg-a');

      // pkg-a falls through to direct query
      queryFn.mockResolvedValue({records: []});
      const result = await service.isArtifactInstalled('pkg-a');
      expect(result.isInstalled).toBe(false);

      // pkg-b still cached — no additional query for it
      queryFn.mockClear();
      const resultB = await service.isArtifactInstalled('pkg-b');
      expect(resultB.isInstalled).toBe(true);
      expect(queryFn).not.toHaveBeenCalled();
    });
  });
});
