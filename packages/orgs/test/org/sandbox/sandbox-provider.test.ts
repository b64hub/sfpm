import {
  beforeEach, describe, expect, it, vi,
} from 'vitest';

import {OrgError} from '../../../src/org/types.js';

// ---------------------------------------------------------------------------
// Mock @salesforce/core before imports
// ---------------------------------------------------------------------------

const mockConnection = {
  getApiVersion: vi.fn().mockReturnValue('60.0'),
  query: vi.fn(),
  request: vi.fn(),
  sobject: vi.fn(),
};

const mockSobject = {
  describe: vi.fn(),
  destroy: vi.fn(),
  retrieve: vi.fn(),
  update: vi.fn(),
};

const mockHubOrg = {
  cloneSandbox: vi.fn(),
  createSandbox: vi.fn(),
  getConnection: vi.fn().mockReturnValue(mockConnection),
  getUsername: vi.fn().mockReturnValue('admin@production.org'),
  querySandboxProcessBySandboxName: vi.fn(),
};

vi.mock('@salesforce/core', () => ({
  Org: {
    create: vi.fn().mockResolvedValue({
      deleteFrom: vi.fn().mockResolvedValue(undefined),
    }),
  },
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

import SandboxProvider from '../../../src/org/sandbox/sandbox-provider.js';

// ============================================================================
// Test Helpers
// ============================================================================

function createStrategy() {
  return new SandboxProvider(mockHubOrg as any);
}

function mockDescribe(fields: Array<{name: string; picklistValues?: Array<{value: string}>}>) {
  mockConnection.sobject.mockReturnValue(mockSobject);
  mockSobject.describe.mockResolvedValue({fields});
}

// ============================================================================
// Tests
// ============================================================================

describe('SandboxProvider', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockConnection.sobject.mockReturnValue(mockSobject);
  });

  // --------------------------------------------------------------------------
  // validate
  // --------------------------------------------------------------------------

  describe('validate', () => {
    const validFields = [
      {name: 'Tag__c'},
      {
        name: 'Allocation_Status__c',
        picklistValues: [
          {value: 'Allocate'},
          {value: 'Assigned'},
          {value: 'Available'},
          {value: 'In Progress'},
          {value: 'Return'},
        ],
      },
      {name: 'Auth_Url__c'},
    ];

    it('should pass when all required fields are present', async () => {
      mockDescribe(validFields);
      const strategy = createStrategy();

      await expect(strategy.validate()).resolves.not.toThrow();
    });

    it('should throw when Tag__c is missing', async () => {
      mockDescribe(validFields.filter(f => f.name !== 'Tag__c'));
      const strategy = createStrategy();

      await expect(strategy.validate()).rejects.toThrow(OrgError);
      await expect(strategy.validate()).rejects.toThrow('Tag__c');
    });

    it('should throw when Allocation_Status__c is missing', async () => {
      mockDescribe(validFields.filter(f => f.name !== 'Allocation_Status__c'));
      const strategy = createStrategy();

      await expect(strategy.validate()).rejects.toThrow(OrgError);
      await expect(strategy.validate()).rejects.toThrow('Allocation_Status__c');
    });

    it('should throw when Allocation_Status__c has missing picklist values', async () => {
      const partialFields = validFields.map(f => {
        if (f.name === 'Allocation_Status__c') {
          return {...f, picklistValues: [{value: 'Available'}]};
        }

        return f;
      });

      mockDescribe(partialFields);
      const strategy = createStrategy();

      await expect(strategy.validate()).rejects.toThrow('missing required picklist values');
    });

    it('should throw when Auth_Url__c is missing', async () => {
      mockDescribe(validFields.filter(f => f.name !== 'Auth_Url__c'));
      const strategy = createStrategy();

      await expect(strategy.validate()).rejects.toThrow(OrgError);
      await expect(strategy.validate()).rejects.toThrow('Auth_Url__c');
    });
  });

  // --------------------------------------------------------------------------
  // createOrg
  // --------------------------------------------------------------------------

  describe('createOrg', () => {
    it('should create a new sandbox via SDK', async () => {
      mockHubOrg.createSandbox.mockResolvedValue({
        SandboxOrganization: '00D999000000001',
      });

      const strategy = createStrategy();
      const result = await strategy.createOrg({
        alias: 'SB1',
        licenseType: 'DEVELOPER',
        sandboxName: 'SB1',
      });

      expect(mockHubOrg.createSandbox).toHaveBeenCalledWith(
        expect.objectContaining({
          LicenseType: 'DEVELOPER',
          SandboxName: 'SB1',
        }),
        expect.any(Object),
      );
      expect(result.orgType).toBe('sandbox');
      expect(result.orgId).toBe('00D999000000001');
    });

    it('should clone from source sandbox when sourceSandboxName is provided', async () => {
      mockHubOrg.cloneSandbox.mockResolvedValue({
        SandboxOrganization: '00D999000000002',
      });

      const strategy = createStrategy();
      await strategy.createOrg({
        alias: 'SB2',
        sandboxName: 'SB2',
        sourceSandboxName: 'DevTemplate',
      });

      expect(mockHubOrg.cloneSandbox).toHaveBeenCalledWith(
        expect.objectContaining({SandboxName: 'SB2'}),
        'DevTemplate',
        expect.any(Object),
      );
      expect(mockHubOrg.createSandbox).not.toHaveBeenCalled();
    });

    it('should pass activationUserGroupId in the request', async () => {
      mockHubOrg.createSandbox.mockResolvedValue({
        SandboxOrganization: '00D999000000003',
      });

      const strategy = createStrategy();
      await strategy.createOrg({
        activationUserGroupId: '0GR000000000001',
        alias: 'SB3',
        sandboxName: 'SB3',
      });

      expect(mockHubOrg.createSandbox).toHaveBeenCalledWith(
        expect.objectContaining({
          ActivationUserGroupId: '0GR000000000001',
        }),
        expect.any(Object),
      );
    });
  });

  // --------------------------------------------------------------------------
  // generatePassword
  // --------------------------------------------------------------------------

  describe('generatePassword', () => {
    it('should return undefined password (sandboxes inherit production passwords)', async () => {
      const strategy = createStrategy();
      const result = await strategy.generatePassword('user@prod.sb1');

      expect(result).toEqual({password: undefined});
    });
  });

  // --------------------------------------------------------------------------
  // claimOrg
  // --------------------------------------------------------------------------

  describe('claimOrg', () => {
    it('should update Allocation_Status__c to Allocate', async () => {
      mockSobject.update.mockResolvedValue({success: true});
      const strategy = createStrategy();

      const success = await strategy.claimOrg('a00000000000001');

      expect(mockSobject.update).toHaveBeenCalledWith({
        Allocation_Status__c: 'Allocate',
        Id: 'a00000000000001',
      });
      expect(success).toBe(true);
    });

    it('should return false when update fails', async () => {
      mockSobject.update.mockResolvedValue({success: false});
      const strategy = createStrategy();

      const success = await strategy.claimOrg('a00000000000001');
      expect(success).toBe(false);
    });

    it('should return false on error', async () => {
      mockSobject.update.mockRejectedValue(new Error('LOCK_CONTENTION'));
      const strategy = createStrategy();

      const success = await strategy.claimOrg('a00000000000001');
      expect(success).toBe(false);
    });
  });

  // --------------------------------------------------------------------------
  // getActiveCountByTag
  // --------------------------------------------------------------------------

  describe('getActiveCountByTag', () => {
    it('should query count of active sandboxes by tag', async () => {
      mockConnection.query.mockResolvedValue({totalSize: 3});
      const strategy = createStrategy();

      const count = await strategy.getActiveCountByTag('sb-pool');

      expect(count).toBe(3);
      expect(mockConnection.query).toHaveBeenCalledWith(
        expect.stringContaining('sb-pool'),
      );
    });
  });

  // --------------------------------------------------------------------------
  // getAvailableByTag
  // --------------------------------------------------------------------------

  describe('getAvailableByTag', () => {
    it('should return mapped sandbox records', async () => {
      mockConnection.query.mockResolvedValue({
        records: [{
          Allocation_Status__c: 'Available',
          Auth_Url__c: 'force://token@instance.salesforce.com',
          CreatedDate: '2024-01-01T00:00:00.000+0000',
          Id: 'a00000000000001',
          SandboxName: 'SB1',
          SandboxOrganization: '00D999000000001',
          Tag__c: 'sb-pool',
        }],
      });

      const strategy = createStrategy();
      const orgs = await strategy.getAvailableByTag('sb-pool');

      expect(orgs).toHaveLength(1);
      expect(orgs[0].orgType).toBe('sandbox');
      expect(orgs[0].recordId).toBe('a00000000000001');
      expect(orgs[0].orgId).toBe('00D999000000001');
    });
  });

  // --------------------------------------------------------------------------
  // getRemainingCapacity
  // --------------------------------------------------------------------------

  describe('getRemainingCapacity', () => {
    it('should aggregate sandbox limits from the org limits API', async () => {
      mockConnection.request.mockResolvedValue({
        DailyApiRequests: {Max: 1000, Remaining: 900},
        DeveloperProSandbox: {Max: 10, Remaining: 5},
        DeveloperSandbox: {Max: 20, Remaining: 8},
        FullSandbox: {Max: 5, Remaining: 2},
      });

      const strategy = createStrategy();
      const capacity = await strategy.getRemainingCapacity();

      // 5 + 8 + 2 = 15 (all sandbox-related keys)
      expect(capacity).toBe(15);
    });

    it('should return 0 when no sandbox limits are present', async () => {
      mockConnection.request.mockResolvedValue({
        DailyApiRequests: {Max: 1000, Remaining: 900},
      });

      const strategy = createStrategy();
      const capacity = await strategy.getRemainingCapacity();

      expect(capacity).toBe(0);
    });
  });

  // --------------------------------------------------------------------------
  // isOrgActive
  // --------------------------------------------------------------------------

  describe('isOrgActive', () => {
    it('should return true for completed sandbox', async () => {
      mockHubOrg.querySandboxProcessBySandboxName.mockResolvedValue({
        Status: 'Completed',
      });

      const strategy = createStrategy();
      const active = await strategy.isOrgActive('admin@production.org.mysandbox');

      expect(active).toBe(true);
    });

    it('should return false for pending sandbox', async () => {
      mockHubOrg.querySandboxProcessBySandboxName.mockResolvedValue({
        Status: 'Pending',
      });

      const strategy = createStrategy();
      const active = await strategy.isOrgActive('admin@production.org.mysandbox');

      expect(active).toBe(false);
    });

    it('should return false when username has no sandbox suffix', async () => {
      const strategy = createStrategy();
      const active = await strategy.isOrgActive('user@org');

      expect(active).toBe(false);
    });

    it('should return false on query error', async () => {
      mockHubOrg.querySandboxProcessBySandboxName.mockRejectedValue(new Error('Not found'));

      const strategy = createStrategy();
      const active = await strategy.isOrgActive('admin@production.org.sb1');

      expect(active).toBe(false);
    });
  });

  // --------------------------------------------------------------------------
  // updatePoolMetadata
  // --------------------------------------------------------------------------

  describe('updatePoolMetadata', () => {
    it('should update SandboxInfo records with pool metadata', async () => {
      mockSobject.update.mockResolvedValue({success: true});
      const strategy = createStrategy();

      await strategy.updatePoolMetadata([
        {allocationStatus: 'Available', id: 'rec-1', poolTag: 'sb-pool'},
      ]);

      expect(mockSobject.update).toHaveBeenCalledWith([{
        Allocation_Status__c: 'Available',
        Id: 'rec-1',
        Tag__c: 'sb-pool',
      }]);
    });

    it('should skip when no records provided', async () => {
      const strategy = createStrategy();

      await strategy.updatePoolMetadata([]);

      expect(mockSobject.update).not.toHaveBeenCalled();
    });
  });

  // --------------------------------------------------------------------------
  // getUsername
  // --------------------------------------------------------------------------

  describe('getUsername', () => {
    it('should return the hub org username', () => {
      const strategy = createStrategy();

      expect(strategy.getUsername()).toBe('admin@production.org');
    });
  });
});
