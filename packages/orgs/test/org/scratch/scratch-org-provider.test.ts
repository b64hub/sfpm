import {
  beforeEach, describe, expect, it, vi,
} from 'vitest';

import {OrgError} from '../../../src/org/types.js';

// ---------------------------------------------------------------------------
// Mock external dependencies
// ---------------------------------------------------------------------------

vi.mock('@salesforce/core', () => ({
  AuthInfo: {create: vi.fn()},
  Connection: {create: vi.fn()},
  Org: {create: vi.fn()},
  OrgTypes: {
    Sandbox: 'sandbox',
    Scratch: 'scratch',
  },
  StateAggregator: {getInstance: vi.fn()},
}));

vi.mock('@salesforce/kit', () => ({
  Duration: {
    minutes: (m: number) => ({value: m * 60}),
    seconds: (s: number) => ({value: s}),
  },
}));

vi.mock('@b64/sfpm-core', () => ({
  escapeSOQL: (v: string) => v,
  soql: (strings: TemplateStringsArray, ...values: unknown[]) =>
    strings.reduce((acc, str, i) => acc + str + (values[i] ?? ''), ''),
}));

vi.mock('../../../src/utils/password-generator.js', () => ({
  default: vi.fn().mockResolvedValue('TestPass123!'),
}));

import ScratchOrgProvider from '../../../src/org/scratch/scratch-org-provider.js';

// ============================================================================
// Test Helpers
// ============================================================================

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
    soap: {setPassword: vi.fn()},
    sobject: vi.fn().mockReturnValue({
      describe: mockSobjectDescribe,
      destroy: mockSobjectDestroy,
      update: mockSobjectUpdate,
    }),
  };

  const mockOrg = {
    getConnection: vi.fn().mockReturnValue(mockConnection),
    getUsername: vi.fn().mockReturnValue('devhub@example.com'),
    isDevHubOrg: true,
    scratchOrgCreate: vi.fn(),
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

function createSoInfoRecord(overrides?: Record<string, unknown>) {
  return {
    Allocation_Status__c: 'Available',
    Auth_Url__c: 'force://token@instance.salesforce.com',
    CreatedDate: '2025-01-08T00:00:00.000+0000',
    ExpirationDate: '2025-01-15',
    Id: 'a00000000000001',
    LoginUrl: 'https://test.salesforce.com',
    ScratchOrg: '00D000000000001',
    SignupEmail: 'dev@example.com',
    SignupUsername: 'test-1@scratch.org',
    Status: 'Active',
    Tag__c: 'dev-pool',
    ...overrides,
  };
}

// ============================================================================
// Tests
// ============================================================================

describe('ScratchOrgProvider', () => {
  let mocks: ReturnType<typeof createMockOrg>;
  let strategy: ScratchOrgProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    mocks = createMockOrg();
    strategy = new ScratchOrgProvider(mocks.org as any);
  });

  // --------------------------------------------------------------------------
  // constructor
  // --------------------------------------------------------------------------

  describe('constructor', () => {
    it('should throw when org is not a DevHub', () => {
      const notDevHub = {...mocks.org, isDevHubOrg: false};
      expect(() => new ScratchOrgProvider(notDevHub as any)).toThrow('devhub');
    });
  });

  // --------------------------------------------------------------------------
  // validate
  // --------------------------------------------------------------------------

  describe('validate', () => {
    it('should pass when Allocation_Status__c field has all required picklist values', async () => {
      mocks.sobject.describe.mockResolvedValue({
        fields: [{
          name: 'Allocation_Status__c',
          picklistValues: [
            {value: 'Allocated'},
            {value: 'Assigned'},
            {value: 'Available'},
            {value: 'In Progress'},
            {value: 'Return'},
          ],
        }],
      });

      await expect(strategy.validate()).resolves.not.toThrow();
    });

    it('should throw when Allocation_Status__c is missing', async () => {
      mocks.sobject.describe.mockResolvedValue({fields: []});

      await expect(strategy.validate()).rejects.toThrow(OrgError);
      await expect(strategy.validate()).rejects.toThrow('Allocation_Status__c');
    });

    it('should throw when required picklist values are missing', async () => {
      mocks.sobject.describe.mockResolvedValue({
        fields: [{
          name: 'Allocation_Status__c',
          picklistValues: [{value: 'Available'}],
        }],
      });

      await expect(strategy.validate()).rejects.toThrow('missing required picklist values');
    });
  });

  // --------------------------------------------------------------------------
  // claimOrg
  // --------------------------------------------------------------------------

  describe('claimOrg', () => {
    it('should update Allocation_Status__c to Allocated', async () => {
      mocks.sobject.update.mockResolvedValue({success: true});

      const result = await strategy.claimOrg('a00000000000001');

      expect(mocks.sobject.update).toHaveBeenCalledWith({
        Allocation_Status__c: 'Allocated',
        Id: 'a00000000000001',
      });
      expect(result).toBe(true);
    });

    it('should return false on error', async () => {
      mocks.sobject.update.mockRejectedValue(new Error('LOCK'));

      expect(await strategy.claimOrg('a00000000000001')).toBe(false);
    });
  });

  // --------------------------------------------------------------------------
  // createOrg
  // --------------------------------------------------------------------------

  describe('createOrg', () => {
    it('should create a scratch org via SDK and return PoolOrg', async () => {
      const {StateAggregator} = await import('@salesforce/core');
      (StateAggregator.getInstance as ReturnType<typeof vi.fn>).mockResolvedValue({
        aliases: {setAndSave: vi.fn()},
      });

      mocks.org.scratchOrgCreate.mockResolvedValue({
        authFields: {
          instanceUrl: 'https://test.my.salesforce.com',
          loginUrl: 'https://test.salesforce.com',
          orgId: '00D000000000001',
        },
        username: 'test-1@scratch.org',
      });

      // Mock password setting: AuthInfo → Org → Connection → query → soap.setPassword
      const {AuthInfo, Connection, Org} = await import('@salesforce/core');
      const mockAuthInfo = {getFields: vi.fn()};
      (AuthInfo.create as ReturnType<typeof vi.fn>).mockResolvedValue(mockAuthInfo);
      const mockConn = {
        query: vi.fn().mockResolvedValue({records: [{Id: '005000000000001'}]}),
        soap: {setPassword: vi.fn()},
      };
      (Connection.create as ReturnType<typeof vi.fn>).mockResolvedValue(mockConn);
      const mockScratchOrg = {getConnection: vi.fn().mockReturnValue(mockConn)};
      (Org.create as ReturnType<typeof vi.fn>).mockResolvedValue(mockScratchOrg);

      const result = await strategy.createOrg({
        alias: 'SO1',
        definitionFile: 'config/scratch-def.json',
        expiryDays: 7,
      });

      expect(result.orgType).toBe('scratch');
      expect(result.auth.username).toBe('test-1@scratch.org');
      expect(result.orgId).toBe('00D000000000001');
      expect(mocks.org.scratchOrgCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          definitionfile: 'config/scratch-def.json',
          durationDays: 7,
        }),
      );
    });
  });

  // --------------------------------------------------------------------------
  // deleteOrgs
  // --------------------------------------------------------------------------

  describe('deleteOrgs', () => {
    it('should destroy ActiveScratchOrg records', async () => {
      mocks.sobject.destroy.mockResolvedValue({success: true});

      await strategy.deleteOrgs(['rec-1', 'rec-2']);

      expect(mocks.sobject.destroy).toHaveBeenCalledTimes(2);
      expect(mocks.sobject.destroy).toHaveBeenCalledWith('rec-1');
      expect(mocks.sobject.destroy).toHaveBeenCalledWith('rec-2');
    });
  });

  // --------------------------------------------------------------------------
  // getActiveCountByTag
  // --------------------------------------------------------------------------

  describe('getActiveCountByTag', () => {
    it('should return count from SOQL query', async () => {
      mocks.connection.query.mockResolvedValue({totalSize: 5});

      const count = await strategy.getActiveCountByTag('dev-pool');

      expect(count).toBe(5);
    });
  });

  // --------------------------------------------------------------------------
  // getAvailableByTag
  // --------------------------------------------------------------------------

  describe('getAvailableByTag', () => {
    it('should return mapped ScratchOrg records', async () => {
      mocks.connection.query.mockResolvedValue({
        records: [createSoInfoRecord()],
      });

      const orgs = await strategy.getAvailableByTag('dev-pool');

      expect(orgs).toHaveLength(1);
      expect(orgs[0].orgType).toBe('scratch');
      expect(orgs[0].auth.username).toBe('test-1@scratch.org');
      expect(orgs[0].orgId).toBe('00D000000000001');
      expect(orgs[0].recordId).toBe('a00000000000001');
    });

    it('should filter by created user when myPool=true', async () => {
      mocks.connection.query.mockResolvedValue({records: []});

      await strategy.getAvailableByTag('dev-pool', true);

      expect(mocks.connection.query).toHaveBeenCalledWith(
        expect.stringContaining('CreatedById'),
      );
    });
  });

  // --------------------------------------------------------------------------
  // getRemainingCapacity
  // --------------------------------------------------------------------------

  describe('getRemainingCapacity', () => {
    it('should return ActiveScratchOrgs remaining from limits API', async () => {
      mocks.connection.request.mockResolvedValue({
        ActiveScratchOrgs: {Max: 200, Remaining: 42},
      });

      const remaining = await strategy.getRemainingCapacity();

      expect(remaining).toBe(42);
    });

    it('should return 0 when limit key is missing', async () => {
      mocks.connection.request.mockResolvedValue({});

      const remaining = await strategy.getRemainingCapacity();

      expect(remaining).toBe(0);
    });
  });

  // --------------------------------------------------------------------------
  // isOrgActive
  // --------------------------------------------------------------------------

  describe('isOrgActive', () => {
    it('should return true when ActiveScratchOrg exists', async () => {
      mocks.connection.query.mockResolvedValue({
        records: [{Id: 'active-1'}],
        totalSize: 1,
      });

      expect(await strategy.isOrgActive('test@scratch.org')).toBe(true);
    });

    it('should return false when no ActiveScratchOrg found', async () => {
      mocks.connection.query.mockResolvedValue({records: [], totalSize: 0});

      expect(await strategy.isOrgActive('deleted@scratch.org')).toBe(false);
    });
  });

  // --------------------------------------------------------------------------
  // updatePoolMetadata
  // --------------------------------------------------------------------------

  describe('updatePoolMetadata', () => {
    it('should update ScratchOrgInfo records', async () => {
      mocks.sobject.update.mockResolvedValue({success: true});

      await strategy.updatePoolMetadata([
        {allocationStatus: 'Available', id: 'rec-1', password: 'pw123', poolTag: 'dev-pool'},
      ]);

      expect(mocks.sobject.update).toHaveBeenCalledWith([{
        Allocation_Status__c: 'Available',
        Id: 'rec-1',
        Password__c: 'pw123',
        Tag__c: 'dev-pool',
      }]);
    });

    it('should skip when no records provided', async () => {
      await strategy.updatePoolMetadata([]);
      expect(mocks.sobject.update).not.toHaveBeenCalled();
    });
  });
});
