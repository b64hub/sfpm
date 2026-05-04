import {describe, it, expect, vi, beforeEach} from 'vitest';
import {Package2Version, PackageService} from '../../src/package/package-service.js';

// Mock @salesforce/core
vi.mock('@salesforce/core', () => ({
  Org: class {
    static create = vi.fn();
    determineIfDevHubOrg = vi.fn().mockResolvedValue(true);
    getConnection = vi.fn(() => ({
      tooling: {
        query: vi.fn(),
      },
    }));
  },
}));

function makeVersion(major: number, minor: number, patch: number, build: number): Package2Version {
  return {
    Branch: '',
    BuildNumber: build,
    CodeCoverage: {apexCodeCoveragePercentage: 90},
    HasPassedCodeCoverageCheck: true,
    IsPasswordProtected: false,
    IsReleased: false,
    MajorVersion: major,
    MinorVersion: minor,
    Package2: {
      ContainerOptions: 'Unlocked',
      Description: '',
      Id: '0Ho000000000000',
      IsOrgDependent: false,
      Name: 'test-pkg',
      NamespacePrefix: '',
    },
    Package2Id: '0Ho000000000000',
    PatchVersion: patch,
    SubscriberPackageVersionId: `04t${major}${minor}${patch}${build}`,
  };
}

describe('PackageService', () => {
  let service: PackageService;
  let mockOrg: any;
  let mockToolingQuery: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    PackageService.resetInstance();

    mockToolingQuery = vi.fn();
    mockOrg = {
      determineIfDevHubOrg: vi.fn().mockResolvedValue(true),
      getConnection: vi.fn(() => ({
        tooling: {query: mockToolingQuery},
      })),
    };

    service = new PackageService(mockOrg);
  });

  describe('getPackage2VersionById', () => {
    describe('version number validation', () => {
      it('should accept Salesforce 4-part version numbers like 0.1.1.4', async () => {
        mockToolingQuery.mockResolvedValue({records: []});

        const result = await service.getPackage2VersionById('0Ho000000000000', '0.1.1.4');

        expect(result).toEqual([]);
      });

      it('should accept 3-part version numbers', async () => {
        mockToolingQuery.mockResolvedValue({records: []});

        const result = await service.getPackage2VersionById('0Ho000000000000', '1.0.0');

        expect(result).toEqual([]);
      });

      it('should accept 2-part version numbers', async () => {
        mockToolingQuery.mockResolvedValue({records: []});

        const result = await service.getPackage2VersionById('0Ho000000000000', '1.0');

        expect(result).toEqual([]);
      });

      it('should accept single-part version numbers', async () => {
        mockToolingQuery.mockResolvedValue({records: []});

        const result = await service.getPackage2VersionById('0Ho000000000000', '1');

        expect(result).toEqual([]);
      });

      it('should reject invalid version strings', async () => {
        await expect(service.getPackage2VersionById('0Ho000000000000', 'abc')).rejects.toThrow(
          'Invalid version number: abc',
        );
      });

      it('should reject version strings with trailing dots', async () => {
        await expect(service.getPackage2VersionById('0Ho000000000000', '1.0.')).rejects.toThrow(
          'Invalid version number: 1.0.',
        );
      });

      it('should reject version strings with 5+ parts', async () => {
        await expect(service.getPackage2VersionById('0Ho000000000000', '1.0.0.0.0')).rejects.toThrow(
          'Invalid version number: 1.0.0.0.0',
        );
      });
    });

    describe('version sorting', () => {
      it('should sort versions in descending order with Salesforce 4-part build numbers', async () => {
        const v1 = makeVersion(0, 1, 1, 4);
        const v2 = makeVersion(0, 1, 1, 10);
        const v3 = makeVersion(1, 0, 0, 1);

        mockToolingQuery.mockResolvedValue({records: [v1, v3, v2]});

        const result = await service.getPackage2VersionById('0Ho000000000000');

        expect(result.map(r => `${r.MajorVersion}.${r.MinorVersion}.${r.PatchVersion}.${r.BuildNumber}`)).toEqual([
          '1.0.0.1',
          '0.1.1.10',
          '0.1.1.4',
        ]);
      });

      it('should sort correctly when major versions differ', async () => {
        const v1 = makeVersion(1, 0, 0, 1);
        const v2 = makeVersion(2, 0, 0, 1);
        const v3 = makeVersion(3, 0, 0, 1);

        mockToolingQuery.mockResolvedValue({records: [v2, v1, v3]});

        const result = await service.getPackage2VersionById('0Ho000000000000');

        expect(result.map(r => r.MajorVersion)).toEqual([3, 2, 1]);
      });

      it('should return single record without sorting', async () => {
        const v1 = makeVersion(1, 0, 0, 1);

        mockToolingQuery.mockResolvedValue({records: [v1]});

        const result = await service.getPackage2VersionById('0Ho000000000000');

        expect(result).toEqual([v1]);
      });

      it('should handle high build numbers correctly', async () => {
        const v1 = makeVersion(1, 0, 0, 99);
        const v2 = makeVersion(1, 0, 0, 100);

        mockToolingQuery.mockResolvedValue({records: [v1, v2]});

        const result = await service.getPackage2VersionById('0Ho000000000000');

        expect(result[0].BuildNumber).toBe(100);
        expect(result[1].BuildNumber).toBe(99);
      });
    });

    describe('SOQL where clauses', () => {
      it('should include all 4 version parts in the query when provided', async () => {
        mockToolingQuery.mockResolvedValue({records: []});

        await service.getPackage2VersionById('0Ho000000000000', '1.2.3.4');

        const query = mockToolingQuery.mock.calls[0][0] as string;
        expect(query).toContain('MajorVersion = 1');
        expect(query).toContain('MinorVersion = 2');
        expect(query).toContain('PatchVersion = 3');
        expect(query).toContain('BuildNumber = 4');
      });
    });
  });
});
