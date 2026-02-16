import {
  beforeEach, describe, expect, it, vi,
} from 'vitest';

import type {ScratchOrg} from '../../../src/org/scratch/types.js';

import DevHubService from '../../../src/org/services/devhub-service.js';

// ============================================================================
// Test Helpers
// ============================================================================

/**
 * Create a mock Org instance with stubbed connection and methods.
 */
function createMockOrg() {
  const mockSobjectUpdate = vi.fn();
  const mockSobjectDestroy = vi.fn();
  const mockSobjectDescribe = vi.fn();

  const mockConnection = {
    getApiVersion: vi.fn().mockReturnValue('62.0'),
    getAuthInfoFields: vi.fn().mockReturnValue({
      clientId: 'test-client-id',
      loginUrl: 'https://login.salesforce.com',
      privateKey: '/path/to/key.pem',
    }),
    query: vi.fn(),
    request: vi.fn(),
    sobject: vi.fn().mockReturnValue({
      describe: mockSobjectDescribe,
      destroy: mockSobjectDestroy,
      update: mockSobjectUpdate,
    }),
  };

  const mockOrg = {
    getConnection: vi.fn().mockReturnValue(mockConnection),
    getUsername: vi.fn().mockReturnValue('devhub@example.com'),
  };

  return {
    connection: mockConnection,
    org: mockOrg,
    sobject: {
      describe: mockSobjectDescribe,
      destroy: mockSobjectDestroy,
      update: mockSobjectUpdate,
    },
  };
}

/**
 * Create a test ScratchOrgInfo SOQL record with sensible defaults.
 */
function createScratchOrgInfoRecord(overrides?: Record<string, unknown>) {
  return {
    Allocation_status__c: 'Available',
    CreatedDate: '2025-01-08T00:00:00.000+0000',
    ExpirationDate: '2025-01-15',
    Id: 'a00XXXXXXXXXXXXXXX',
    LoginUrl: 'https://test.scratch.org',
    Password__c: 'test-password-123',
    Pooltag__c: 'test-pool',
    ScratchOrg: '00D0000000000000000',
    SfdxAuthUrl__c: 'force://PlatformCLI::5Aep861...',
    SignupEmail: 'test@example.com',
    SignupUsername: 'test@scratch.org',
    ...overrides,
  };
}

// ============================================================================
// DevHubService Tests
// ============================================================================

describe('DevHubService', () => {
  let devHub: DevHubService;
  let mockOrg: ReturnType<typeof createMockOrg>['org'];
  let conn: ReturnType<typeof createMockOrg>['connection'];
  let sobject: ReturnType<typeof createMockOrg>['sobject'];

  beforeEach(() => {
    const mocks = createMockOrg();
    mockOrg = mocks.org;
    conn = mocks.connection;
    sobject = mocks.sobject;
    devHub = new DevHubService(mockOrg as any);
  });

  // ==========================================================================
  // DevHub interface
  // ==========================================================================

  describe('getUsername', () => {
    it('should return the DevHub username', () => {
      expect(devHub.getUsername()).toBe('devhub@example.com');
    });
  });

  describe('getJwtConfig', () => {
    it('should return JWT config from auth info fields', () => {
      const config = devHub.getJwtConfig();

      expect(config).toEqual({
        clientId: 'test-client-id',
        loginUrl: 'https://login.salesforce.com',
        privateKeyPath: '/path/to/key.pem',
      });
    });

    it('should default to empty strings when fields are missing', () => {
      conn.getAuthInfoFields.mockReturnValue({});

      const config = devHub.getJwtConfig();

      expect(config.clientId).toBe('');
      expect(config.privateKeyPath).toBe('');
    });
  });

  describe('claimOrg', () => {
    it('should update ScratchOrgInfo Allocation_status__c to "Allocate"', async () => {
      sobject.update.mockResolvedValue({success: true});

      const result = await devHub.claimOrg('a00XXXXXXXXXXXXXXX');

      expect(conn.sobject).toHaveBeenCalledWith('ScratchOrgInfo');
      expect(sobject.update).toHaveBeenCalledWith({
        Allocation_status__c: 'Allocate',
        Id: 'a00XXXXXXXXXXXXXXX',
      });
      expect(result).toBe(true);
    });

    it('should return false when update reports failure', async () => {
      sobject.update.mockResolvedValue({success: false});

      const result = await devHub.claimOrg('a00XXXXXXXXXXXXXXX');

      expect(result).toBe(false);
    });

    it('should return false on concurrent claim (optimistic concurrency)', async () => {
      sobject.update.mockRejectedValue(new Error('ENTITY_IS_LOCKED'));

      const result = await devHub.claimOrg('a00XXXXXXXXXXXXXXX');

      expect(result).toBe(false);
    });
  });

  describe('deleteActiveScratchOrgs', () => {
    it('should delete each ActiveScratchOrg record', async () => {
      sobject.destroy.mockResolvedValue({id: 'x', success: true});

      await devHub.deleteActiveScratchOrgs(['id-1', 'id-2', 'id-3']);

      expect(conn.sobject).toHaveBeenCalledWith('ActiveScratchOrg');
      expect(sobject.destroy).toHaveBeenCalledTimes(3);
      expect(sobject.destroy).toHaveBeenNthCalledWith(1, 'id-1');
      expect(sobject.destroy).toHaveBeenNthCalledWith(2, 'id-2');
      expect(sobject.destroy).toHaveBeenNthCalledWith(3, 'id-3');
    });

    it('should handle empty array', async () => {
      await devHub.deleteActiveScratchOrgs([]);

      expect(sobject.destroy).not.toHaveBeenCalled();
    });
  });

  describe('getActiveCountByTag', () => {
    it('should query count of active orgs and return totalSize', async () => {
      conn.query.mockResolvedValue({records: [], totalSize: 42});

      const count = await devHub.getActiveCountByTag('test-pool');

      const query = conn.query.mock.calls[0][0] as string;
      expect(query).toContain('count()');
      expect(query).toContain("Pooltag__c = 'test-pool'");
      expect(query).toContain("Status = 'Active'");
      expect(count).toBe(42);
    });

    it('should return 0 when no active orgs', async () => {
      conn.query.mockResolvedValue({records: [], totalSize: 0});

      const count = await devHub.getActiveCountByTag('empty-pool');

      expect(count).toBe(0);
    });

    it('should escape the tag in the query', async () => {
      conn.query.mockResolvedValue({records: [], totalSize: 0});

      await devHub.getActiveCountByTag("tag' OR '1'='1");

      const query = conn.query.mock.calls[0][0] as string;
      expect(query).toContain(String.raw`tag\' OR \'1\'=\'1`);
    });
  });

  describe('getAvailableByTag', () => {
    it('should query orgs with Available or In Progress status', async () => {
      const record = createScratchOrgInfoRecord({Allocation_status__c: 'Available'});
      conn.query.mockResolvedValue({records: [record]});

      const result = await devHub.getAvailableByTag('test-pool');

      const query = conn.query.mock.calls[0][0] as string;
      expect(query).toContain("Allocation_status__c = 'Available'");
      expect(query).toContain("Allocation_status__c = 'In Progress'");
      expect(query).toContain("Status = 'Active'");
      expect(result).toHaveLength(1);
      expect(result[0].status).toBe('Available');
    });

    it('should return empty array when no available orgs', async () => {
      conn.query.mockResolvedValue({records: []});

      const result = await devHub.getAvailableByTag('empty-pool');

      expect(result).toEqual([]);
    });

    it('should filter by CreatedById when myPool is true', async () => {
      conn.query.mockResolvedValue({records: []});

      await devHub.getAvailableByTag('test-pool', true);

      const query = conn.query.mock.calls[0][0] as string;
      expect(query).toContain("CreatedById = 'devhub@example.com'");
    });
  });

  describe('getOrgsByTag', () => {
    it('should query ScratchOrgInfo and map records', async () => {
      const record = createScratchOrgInfoRecord();
      // First query: ScratchOrgInfo. Second query: ActiveScratchOrg (resolveActiveRecordIds)
      conn.query
      .mockResolvedValueOnce({records: [record]})
      .mockResolvedValueOnce({records: []});

      const result = await devHub.getOrgsByTag('test-pool');

      expect(result).toHaveLength(1);
      expect(result[0]).toMatchObject({
        orgId: '00D0000000000000000',
        tag: 'test-pool',
        username: 'test@scratch.org',
      });
    });

    it('should resolve ActiveScratchOrg record IDs', async () => {
      const record = createScratchOrgInfoRecord({Id: 'info-id-1'});
      conn.query
      .mockResolvedValueOnce({records: [record]})
      .mockResolvedValueOnce({
        records: [{Id: 'active-id-1', ScratchOrgInfoId: 'info-id-1'}],
      });

      const result = await devHub.getOrgsByTag('test-pool');

      // The second query should look up ActiveScratchOrg
      const secondQuery = conn.query.mock.calls[1][0] as string;
      expect(secondQuery).toContain('ActiveScratchOrg');
      expect(secondQuery).toContain("'info-id-1'");
      // The resolved active record ID should be set on the org
      expect(result[0].recordId).toBe('active-id-1');
    });

    it('should return empty array when no orgs found', async () => {
      conn.query.mockResolvedValue({records: []});

      const result = await devHub.getOrgsByTag('nonexistent-pool');

      expect(result).toEqual([]);
    });

    it('should escape SOQL injection in tag', async () => {
      conn.query.mockResolvedValue({records: []});

      await devHub.getOrgsByTag("test' OR '1'='1");

      const query = conn.query.mock.calls[0][0] as string;
      expect(query).toContain(String.raw`test\' OR \'1\'=\'1`);
    });

    it('should filter by CreatedById when myPool is true', async () => {
      conn.query.mockResolvedValue({records: []});

      await devHub.getOrgsByTag('test-pool', true);

      const query = conn.query.mock.calls[0][0] as string;
      expect(query).toContain("Pooltag__c = 'test-pool'");
      expect(query).toContain("CreatedById = 'devhub@example.com'");
    });
  });

  describe('getOrphanedScratchOrgs', () => {
    it('should query orgs without a pool tag', async () => {
      conn.query.mockResolvedValue({records: []});

      await devHub.getOrphanedScratchOrgs();

      const query = conn.query.mock.calls[0][0] as string;
      expect(query).toContain('Pooltag__c = null');
      expect(query).toContain("Status = 'Active'");
    });
  });

  describe('getUserEmail', () => {
    it('should query User email by username', async () => {
      conn.query.mockResolvedValue({
        records: [{Email: 'user@example.com'}],
      });

      const email = await devHub.getUserEmail('test@scratch.org');

      expect(conn.query).toHaveBeenCalledWith(expect.stringContaining("Username = 'test@scratch.org'"));
      expect(email).toBe('user@example.com');
    });

    it('should throw OrgError when user not found', async () => {
      conn.query.mockResolvedValue({records: []});

      await expect(devHub.getUserEmail('missing@scratch.org')).rejects.toThrow('No user found with username missing@scratch.org in the DevHub.');
    });

    it('should escape SOQL injection in username', async () => {
      conn.query.mockResolvedValue({records: []});

      await expect(devHub.getUserEmail("test' OR '1'='1")).rejects.toThrow();

      const query = conn.query.mock.calls[0][0] as string;
      expect(query).toContain(String.raw`test\' OR \'1\'=\'1`);
    });
  });

  describe('isOrgActive', () => {
    it('should return true when ActiveScratchOrg record exists', async () => {
      conn.query.mockResolvedValue({records: [{Id: 'asr-id'}], totalSize: 1});

      const result = await devHub.isOrgActive('test@scratch.org');

      expect(result).toBe(true);
      const query = conn.query.mock.calls[0][0] as string;
      expect(query).toContain('ActiveScratchOrg');
      expect(query).toContain("SignupUsername = 'test@scratch.org'");
    });

    it('should return false when no ActiveScratchOrg record', async () => {
      conn.query.mockResolvedValue({records: [], totalSize: 0});

      const result = await devHub.isOrgActive('expired@scratch.org');

      expect(result).toBe(false);
    });
  });

  describe('getRemainingCapacity', () => {
    it('should query org limits and return ActiveScratchOrgs remaining', async () => {
      conn.request.mockResolvedValue({
        ActiveScratchOrgs: {Max: 200, Remaining: 150},
      });

      const remaining = await devHub.getRemainingCapacity();

      expect(conn.request).toHaveBeenCalledWith('/services/data/v62.0/limits');
      expect(remaining).toBe(150);
    });

    it('should return 0 when at capacity', async () => {
      conn.request.mockResolvedValue({
        ActiveScratchOrgs: {Max: 50, Remaining: 0},
      });

      const remaining = await devHub.getRemainingCapacity();

      expect(remaining).toBe(0);
    });

    it('should return 0 when limits data is missing', async () => {
      conn.request.mockResolvedValue({});

      const remaining = await devHub.getRemainingCapacity();

      expect(remaining).toBe(0);
    });
  });

  // ==========================================================================
  // PoolInfoProvider interface
  // ==========================================================================

  describe('getScratchOrgInfoByUsername', () => {
    it('should return ScratchOrgInfo Id for a username', async () => {
      conn.query.mockResolvedValue({records: [{Id: 'soi-123'}]});

      const id = await devHub.getScratchOrgInfoByUsername('test@scratch.org');

      expect(id).toBe('soi-123');
      const query = conn.query.mock.calls[0][0] as string;
      expect(query).toContain("SignupUsername = 'test@scratch.org'");
    });

    it('should return undefined when not found', async () => {
      conn.query.mockResolvedValue({records: []});

      const id = await devHub.getScratchOrgInfoByUsername('nope@scratch.org');

      expect(id).toBeUndefined();
    });
  });

  describe('getScratchOrgUsageByUser', () => {
    it('should return usage counts grouped by email', async () => {
      conn.query.mockResolvedValue({
        records: [
          {In_Use: 5, SignupEmail: 'alice@example.com'},
          {In_Use: 3, SignupEmail: 'bob@example.com'},
        ],
      });

      const usage = await devHub.getScratchOrgUsageByUser();

      expect(usage).toEqual([
        {count: 5, email: 'alice@example.com'},
        {count: 3, email: 'bob@example.com'},
      ]);
    });

    it('should return empty array when no active orgs', async () => {
      conn.query.mockResolvedValue({records: []});

      const usage = await devHub.getScratchOrgUsageByUser();

      expect(usage).toEqual([]);
    });
  });

  describe('sendEmail', () => {
    it('should call the emailSimple action endpoint', async () => {
      conn.request.mockResolvedValue({});

      await devHub.sendEmail({
        body: 'Email body text',
        subject: 'Test Subject',
        to: 'recipient@example.com',
      });

      expect(conn.request).toHaveBeenCalledWith({
        body: expect.stringContaining('"emailSubject":"Test Subject"'),
        method: 'POST',
        url: '/services/data/v62.0/actions/standard/emailSimple',
      });
    });
  });

  // ==========================================================================
  // PoolOrgSource interface
  // ==========================================================================

  describe('updatePoolMetadata', () => {
    it('should batch-update ScratchOrgInfo records', async () => {
      sobject.update.mockResolvedValue([{success: true}, {success: true}]);

      await devHub.updatePoolMetadata([
        {
          allocationStatus: 'Available', id: 'id-1', password: 'pw1', poolTag: 'pool-1',
        },
        {
          allocationStatus: 'Assigned', id: 'id-2', password: 'pw2', poolTag: 'pool-1',
        },
      ]);

      expect(conn.sobject).toHaveBeenCalledWith('ScratchOrgInfo');
      expect(sobject.update).toHaveBeenCalledWith([
        {
          Allocation_status__c: 'Available', Id: 'id-1', Password__c: 'pw1', Pooltag__c: 'pool-1',
        },
        {
          Allocation_status__c: 'Assigned', Id: 'id-2', Password__c: 'pw2', Pooltag__c: 'pool-1',
        },
      ]);
    });

    it('should skip update when records array is empty', async () => {
      await devHub.updatePoolMetadata([]);

      expect(sobject.update).not.toHaveBeenCalled();
    });
  });

  describe('updateScratchOrgInfo', () => {
    it('should update ScratchOrgInfo and return true on success', async () => {
      sobject.update.mockResolvedValue({success: true});

      const result = await devHub.updateScratchOrgInfo({
        Id: 'a00XXXXXXXXXXXXXXX',
        Pooltag__c: 'new-tag',
      });

      expect(result).toBe(true);
      expect(conn.sobject).toHaveBeenCalledWith('ScratchOrgInfo');
    });

    it('should return false on failure', async () => {
      sobject.update.mockResolvedValue({success: false});

      const result = await devHub.updateScratchOrgInfo({Id: 'invalid'});

      expect(result).toBe(false);
    });
  });

  // ==========================================================================
  // PoolPrerequisiteChecker interface
  // ==========================================================================

  describe('validate', () => {
    it('should pass when Allocation_status__c field has all required values', async () => {
      sobject.describe.mockResolvedValue({
        fields: [{
          name: 'Allocation_status__c',
          picklistValues: [
            {value: 'Allocate'},
            {value: 'Assigned'},
            {value: 'Available'},
            {value: 'In Progress'},
            {value: 'Return'},
          ],
        }],
      });

      await expect(devHub.validate()).resolves.toBeUndefined();
    });

    it('should throw when Allocation_status__c field is missing', async () => {
      sobject.describe.mockResolvedValue({
        fields: [{name: 'Status', picklistValues: []}],
      });

      await expect(devHub.validate()).rejects.toThrow('missing the "Allocation_status__c" custom field');
    });

    it('should throw when required picklist values are missing', async () => {
      sobject.describe.mockResolvedValue({
        fields: [{
          name: 'Allocation_status__c',
          picklistValues: [
            {value: 'Available'},
            // Missing: Allocate, Assigned, In Progress, Return
          ],
        }],
      });

      await expect(devHub.validate()).rejects.toThrow('missing required picklist values');
    });
  });

  // ==========================================================================
  // mapToScratchOrg (tested via getAvailableByTag – no resolveActiveRecordIds)
  // ==========================================================================

  describe('field mapping (mapToScratchOrg)', () => {
    it('should correctly map all ScratchOrgInfo fields to ScratchOrg', async () => {
      const record = createScratchOrgInfoRecord({
        Allocation_status__c: 'Assigned',
        ExpirationDate: '2025-12-31',
        Id: 'record-id-123',
        LoginUrl: 'https://mapped.scratch.org',
        Password__c: 'pw-123',
        Pooltag__c: 'my-pool',
        ScratchOrg: 'org-id-456',
        SfdxAuthUrl__c: 'force://mapped',
        SignupEmail: 'mapped@example.com',
        SignupUsername: 'mapped@scratch.org',
      });

      // getAvailableByTag doesn't call resolveActiveRecordIds — simpler for mapping tests
      conn.query.mockResolvedValue({records: [record]});
      const [result] = await devHub.getAvailableByTag('my-pool');

      expect(result).toEqual<ScratchOrg>({
        expiryDate: '2025-12-31',
        loginURL: 'https://mapped.scratch.org',
        orgId: 'org-id-456',
        password: 'pw-123',
        recordId: 'record-id-123',
        sfdxAuthUrl: 'force://mapped',
        signupEmail: 'mapped@example.com',
        status: 'Assigned',
        tag: 'my-pool',
        username: 'mapped@scratch.org',
      });
    });

    it('should handle missing optional fields gracefully', async () => {
      const minimalRecord = {
        Id: 'min-id',
        SignupUsername: 'min@scratch.org',
      };

      conn.query.mockResolvedValue({records: [minimalRecord]});
      const [result] = await devHub.getAvailableByTag('pool');

      expect(result.recordId).toBe('min-id');
      expect(result.username).toBe('min@scratch.org');
      expect(result.password).toBeUndefined();
      expect(result.tag).toBeUndefined();
      expect(result.sfdxAuthUrl).toBeUndefined();
    });
  });
});
