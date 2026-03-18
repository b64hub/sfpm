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

/** Mock sobject for Sandbox_Pool_Org__c operations. */
const mockPoolSobject = {
  create: vi.fn(),
  describe: vi.fn(),
  destroy: vi.fn(),
  retrieve: vi.fn(),
  update: vi.fn(),
};

/** Mock sobject for SandboxInfo operations. */
const mockSandboxInfoSobject = {
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

/**
 * Route `conn.sobject(name)` to the correct mock based on the SObject name.
 */
function setupSobjectRouting() {
  mockConnection.sobject.mockImplementation((name: string) => {
    if (name === 'Sandbox_Pool_Org__c') return mockPoolSobject;
    if (name === 'SandboxInfo') return mockSandboxInfoSobject;
    return mockPoolSobject; // fallback
  });
}

vi.mock('@salesforce/core', () => ({
  Org: {
    create: vi.fn().mockResolvedValue({
      deleteFrom: vi.fn().mockResolvedValue(undefined),
    }),
  },
  OrgTypes: {
    Sandbox: 'sandbox',
    Scratch: 'scratch',
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

vi.mock('../../../src/utils/password-generator.js', () => ({
  default: vi.fn().mockResolvedValue('MockPass123!'),
}));

import SandboxProvider from '../../../src/org/sandbox/sandbox-provider.js';

// ============================================================================
// Test Helpers
// ============================================================================

function createProvider() {
  return new SandboxProvider(mockHubOrg as any);
}

function mockPoolOrgDescribe(fields: Array<{name: string; picklistValues?: Array<{value: string}>}>) {
  mockPoolSobject.describe.mockResolvedValue({fields});
}

// ============================================================================
// Tests
// ============================================================================

describe('SandboxProvider', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setupSobjectRouting();
  });

  // --------------------------------------------------------------------------
  // validate
  // --------------------------------------------------------------------------

  describe('validate', () => {
    const validFields = [
      {name: 'Org_Id__c'},
      {name: 'Tag__c'},
      {
        name: 'Allocation_Status__c',
        picklistValues: [
          {value: 'Allocated'},
          {value: 'Assigned'},
          {value: 'Available'},
          {value: 'In Progress'},
          {value: 'Return'},
        ],
      },
      {name: 'Auth_Url__c'},
    ];

    it('should pass when all required fields are present', async () => {
      // Prune: no pool records
      mockConnection.query.mockResolvedValueOnce({records: []});
      mockPoolOrgDescribe(validFields);
      const provider = createProvider();

      await expect(provider.validate()).resolves.not.toThrow();
    });

    it('should throw when Sandbox_Pool_Org__c object does not exist', async () => {
      // Prune: no pool records
      mockConnection.query.mockResolvedValueOnce({records: []});
      mockPoolSobject.describe.mockRejectedValue(new Error('INVALID_TYPE'));
      const provider = createProvider();

      await expect(provider.validate()).rejects.toThrow(OrgError);
      await expect(provider.validate()).rejects.toThrow('Sandbox_Pool_Org__c');
    });

    it('should throw when Org_Id__c is missing', async () => {
      mockConnection.query.mockResolvedValueOnce({records: []});
      mockPoolOrgDescribe(validFields.filter(f => f.name !== 'Org_Id__c'));
      const provider = createProvider();

      await expect(provider.validate()).rejects.toThrow(OrgError);
      await expect(provider.validate()).rejects.toThrow('Org_Id__c');
    });

    it('should throw when Tag__c is missing', async () => {
      mockConnection.query.mockResolvedValueOnce({records: []});
      mockPoolOrgDescribe(validFields.filter(f => f.name !== 'Tag__c'));
      const provider = createProvider();

      await expect(provider.validate()).rejects.toThrow(OrgError);
      await expect(provider.validate()).rejects.toThrow('Tag__c');
    });

    it('should throw when Allocation_Status__c is missing', async () => {
      mockConnection.query.mockResolvedValueOnce({records: []});
      mockPoolOrgDescribe(validFields.filter(f => f.name !== 'Allocation_Status__c'));
      const provider = createProvider();

      await expect(provider.validate()).rejects.toThrow(OrgError);
      await expect(provider.validate()).rejects.toThrow('Allocation_Status__c');
    });

    it('should throw when Allocation_Status__c has missing picklist values', async () => {
      mockConnection.query.mockResolvedValueOnce({records: []});
      const partialFields = validFields.map(f => {
        if (f.name === 'Allocation_Status__c') {
          return {...f, picklistValues: [{value: 'Available'}]};
        }

        return f;
      });

      mockPoolOrgDescribe(partialFields);
      const provider = createProvider();

      await expect(provider.validate()).rejects.toThrow('missing required picklist values');
    });

    it('should throw when Auth_Url__c is missing', async () => {
      mockConnection.query.mockResolvedValueOnce({records: []});
      mockPoolOrgDescribe(validFields.filter(f => f.name !== 'Auth_Url__c'));
      const provider = createProvider();

      await expect(provider.validate()).rejects.toThrow(OrgError);
      await expect(provider.validate()).rejects.toThrow('Auth_Url__c');
    });
  });

  // --------------------------------------------------------------------------
  // createOrg
  // --------------------------------------------------------------------------

  describe('createOrg', () => {
    it('should create a new sandbox via SDK and insert a pool record', async () => {
      // Mock the Group query for getGroupId
      mockConnection.query.mockResolvedValue({
        records: [{Id: '0GR000000000001'}],
      });
      mockHubOrg.createSandbox.mockResolvedValue({
        SandboxOrganization: '00D999000000001',
      });
      mockPoolSobject.create.mockResolvedValue({id: 'a01000000000001', success: true});

      const provider = createProvider();
      const result = await provider.createOrg({
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

      // Verify pool record was created
      expect(mockPoolSobject.create).toHaveBeenCalledWith(
        expect.objectContaining({
          Allocation_Status__c: 'In Progress',
          Org_Id__c: '00D999000000001',
        }),
      );
      expect(result.recordId).toBe('a01000000000001');
    });

    it('should clone from source sandbox when sourceSandboxName is provided', async () => {
      mockConnection.query.mockResolvedValue({
        records: [{Id: '0GR000000000001'}],
      });
      mockHubOrg.cloneSandbox.mockResolvedValue({
        SandboxOrganization: '00D999000000002',
      });
      mockPoolSobject.create.mockResolvedValue({id: 'a01000000000002', success: true});

      const provider = createProvider();
      await provider.createOrg({
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

    it('should pass activationUserGroupName to resolve group ID', async () => {
      mockConnection.query.mockResolvedValue({
        records: [{Id: '0GR000000000001'}],
      });
      mockHubOrg.createSandbox.mockResolvedValue({
        SandboxOrganization: '00D999000000003',
      });
      mockPoolSobject.create.mockResolvedValue({id: 'a01000000000003', success: true});

      const provider = createProvider();
      await provider.createOrg({
        activationUserGroupName: 'My_Group',
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
  // setPassword
  // --------------------------------------------------------------------------

  describe('setPassword', () => {
    it('should return a generated password', async () => {
      const provider = createProvider();
      const result = await provider.setPassword('user@prod.sb1');

      expect(result.password).toBeDefined();
      expect(typeof result.password).toBe('string');
    });
  });

  // --------------------------------------------------------------------------
  // claimOrg
  // --------------------------------------------------------------------------

  describe('claimOrg', () => {
    it('should update Allocation_Status__c to Allocated on Sandbox_Pool_Org__c', async () => {
      mockPoolSobject.update.mockResolvedValue({success: true});
      const provider = createProvider();

      const success = await provider.claimOrg('a01000000000001');

      expect(mockConnection.sobject).toHaveBeenCalledWith('Sandbox_Pool_Org__c');
      expect(mockPoolSobject.update).toHaveBeenCalledWith({
        Allocation_Status__c: 'Allocated',
        Id: 'a01000000000001',
      });
      expect(success).toBe(true);
    });

    it('should return false when update fails', async () => {
      mockPoolSobject.update.mockResolvedValue({success: false});
      const provider = createProvider();

      const success = await provider.claimOrg('a01000000000001');
      expect(success).toBe(false);
    });

    it('should return false on error', async () => {
      mockPoolSobject.update.mockRejectedValue(new Error('LOCK_CONTENTION'));
      const provider = createProvider();

      const success = await provider.claimOrg('a01000000000001');
      expect(success).toBe(false);
    });
  });

  // --------------------------------------------------------------------------
  // getActiveCountByTag
  // --------------------------------------------------------------------------

  describe('getActiveCountByTag', () => {
    it('should query count of pool records by tag', async () => {
      mockConnection.query
        .mockResolvedValueOnce({records: []}) // prune
        .mockResolvedValueOnce({totalSize: 3}); // actual count query
      const provider = createProvider();

      const count = await provider.getActiveCountByTag('sb-pool');

      expect(count).toBe(3);
    });
  });

  // --------------------------------------------------------------------------
  // getAvailableByTag
  // --------------------------------------------------------------------------

  describe('getAvailableByTag', () => {
    it('should return mapped sandbox records from pool + SandboxInfo queries', async () => {
      mockConnection.query
        .mockResolvedValueOnce({records: []}) // prune
        // Pool record query
        .mockResolvedValueOnce({
          records: [{
            Allocation_Status__c: 'Available',
            Auth_Url__c: 'force://token@instance.salesforce.com',
            CreatedDate: '2024-01-01T00:00:00.000+0000',
            Id: 'a01000000000001',
            Org_Id__c: '00D999000000001',
            Tag__c: 'sb-pool',
          }],
        })
        // SandboxInfo enrichment query
        .mockResolvedValueOnce({
          records: [{
            EndDate: '2025-06-01',
            Id: 'sbx000000000001',
            SandboxName: 'SB1',
            SandboxOrganization: '00D999000000001',
            Status: 'Active',
          }],
        });

      const provider = createProvider();
      const orgs = await provider.getAvailableByTag('sb-pool');

      expect(orgs).toHaveLength(1);
      expect(orgs[0].orgType).toBe('sandbox');
      expect(orgs[0].recordId).toBe('a01000000000001');
      expect(orgs[0].orgId).toBe('00D999000000001');
      expect(orgs[0].auth.authUrl).toBe('force://token@instance.salesforce.com');
    });

    it('should return empty array when no pool records match', async () => {
      mockConnection.query
        .mockResolvedValueOnce({records: []}) // prune
        .mockResolvedValueOnce({records: []}); // pool query

      const provider = createProvider();
      const orgs = await provider.getAvailableByTag('sb-pool');

      expect(orgs).toHaveLength(0);
    });
  });

  // --------------------------------------------------------------------------
  // getOrphanedOrgs
  // --------------------------------------------------------------------------

  describe('getOrphanedOrgs', () => {
    it('should return sandboxes with no corresponding pool record', async () => {
      // First call: all active SandboxInfo; second call: all pool records
      mockConnection.query
        .mockResolvedValueOnce({
          records: [
            {Id: 'sbx-1', SandboxName: 'SB1', SandboxOrganization: '00D000000000001'},
            {Id: 'sbx-2', SandboxName: 'SB2', SandboxOrganization: '00D000000000002'},
          ],
        })
        .mockResolvedValueOnce({
          records: [
            {Org_Id__c: '00D000000000001'}, // SB1 is managed
          ],
        });

      const provider = createProvider();
      const orphans = await provider.getOrphanedOrgs();

      expect(orphans).toHaveLength(1);
      expect(orphans[0].orgId).toBe('00D000000000002');
    });

    it('should return empty when no active sandboxes exist', async () => {
      mockConnection.query.mockResolvedValue({records: []});

      const provider = createProvider();
      const orphans = await provider.getOrphanedOrgs();

      expect(orphans).toHaveLength(0);
    });
  });

  // --------------------------------------------------------------------------
  // deleteOrgs
  // --------------------------------------------------------------------------

  describe('deleteOrgs', () => {
    it('should look up pool record, delete sandbox via SDK, then delete pool record', async () => {
      mockPoolSobject.retrieve.mockResolvedValue({
        Id: 'a01000000000001',
        Org_Id__c: '00D999000000001',
      });
      mockConnection.query.mockResolvedValue({
        records: [{Id: 'sbx-1', SandboxName: 'SB1'}],
      });
      mockHubOrg.querySandboxProcessBySandboxName.mockResolvedValue({
        SandboxOrganization: '00D999000000001',
      });
      mockPoolSobject.destroy.mockResolvedValue({success: true});

      const provider = createProvider();
      await provider.deleteOrgs(['a01000000000001']);

      expect(mockPoolSobject.retrieve).toHaveBeenCalledWith('a01000000000001');
      expect(mockPoolSobject.destroy).toHaveBeenCalledWith('a01000000000001');
    });

    it('should still destroy pool record when sandbox SDK deletion fails', async () => {
      mockPoolSobject.retrieve.mockRejectedValue(new Error('Not found'));
      mockPoolSobject.destroy.mockResolvedValue({success: true});

      const provider = createProvider();
      await provider.deleteOrgs(['a01000000000001']);

      // Pool record cleanup should still be attempted
      expect(mockPoolSobject.destroy).toHaveBeenCalledWith('a01000000000001');
    });
  });

  // --------------------------------------------------------------------------
  // getRecordIds
  // --------------------------------------------------------------------------

  describe('getRecordIds', () => {
    it('should look up Sandbox_Pool_Org__c IDs by org ID', async () => {
      mockConnection.query.mockResolvedValue({
        records: [{Id: 'a01000000000001', Org_Id__c: '00D999000000001'}],
      });

      const provider = createProvider();
      const orgs = [{orgId: '00D999000000001', orgType: 'sandbox', auth: {username: ''}} as any];
      const result = await provider.getRecordIds(orgs);

      expect(result[0].recordId).toBe('a01000000000001');
      expect(mockConnection.query).toHaveBeenCalledWith(
        expect.stringContaining('Sandbox_Pool_Org__c'),
      );
    });

    it('should skip orgs that already have a recordId', async () => {
      const provider = createProvider();
      const orgs = [{orgId: '00D999000000001', orgType: 'sandbox', auth: {username: ''}, recordId: 'existing'} as any];
      const result = await provider.getRecordIds(orgs);

      expect(result[0].recordId).toBe('existing');
      expect(mockConnection.query).not.toHaveBeenCalled();
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

      const provider = createProvider();
      const capacity = await provider.getRemainingCapacity();

      // 5 + 8 + 2 = 15 (all sandbox-related keys)
      expect(capacity).toBe(15);
    });

    it('should return 0 when no sandbox limits are present', async () => {
      mockConnection.request.mockResolvedValue({
        DailyApiRequests: {Max: 1000, Remaining: 900},
      });

      const provider = createProvider();
      const capacity = await provider.getRemainingCapacity();

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

      const provider = createProvider();
      const active = await provider.isOrgActive('admin@production.org.mysandbox');

      expect(active).toBe(true);
    });

    it('should return false for pending sandbox', async () => {
      mockHubOrg.querySandboxProcessBySandboxName.mockResolvedValue({
        Status: 'Pending',
      });

      const provider = createProvider();
      const active = await provider.isOrgActive('admin@production.org.mysandbox');

      expect(active).toBe(false);
    });

    it('should return false when username has no sandbox suffix', async () => {
      const provider = createProvider();
      const active = await provider.isOrgActive('user@org');

      expect(active).toBe(false);
    });

    it('should return false on query error', async () => {
      mockHubOrg.querySandboxProcessBySandboxName.mockRejectedValue(new Error('Not found'));

      const provider = createProvider();
      const active = await provider.isOrgActive('admin@production.org.sb1');

      expect(active).toBe(false);
    });
  });

  // --------------------------------------------------------------------------
  // updatePoolMetadata
  // --------------------------------------------------------------------------

  describe('updatePoolMetadata', () => {
    it('should update Sandbox_Pool_Org__c records with pool metadata', async () => {
      mockPoolSobject.update.mockResolvedValue({success: true});
      const provider = createProvider();

      await provider.updatePoolMetadata([
        {allocationStatus: 'Available', authUrl: 'force://url', id: 'rec-1', poolTag: 'sb-pool'},
      ]);

      expect(mockConnection.sobject).toHaveBeenCalledWith('Sandbox_Pool_Org__c');
      expect(mockPoolSobject.update).toHaveBeenCalledWith([{
        Allocation_Status__c: 'Available',
        Auth_Url__c: 'force://url',
        Id: 'rec-1',
        Tag__c: 'sb-pool',
      }]);
    });

    it('should skip when no records provided', async () => {
      const provider = createProvider();

      await provider.updatePoolMetadata([]);

      expect(mockPoolSobject.update).not.toHaveBeenCalled();
    });
  });

  // --------------------------------------------------------------------------
  // pruning (via public methods that trigger it)
  // --------------------------------------------------------------------------

  describe('pruning stale pool records', () => {
    it('should delete pool records whose sandbox no longer exists', async () => {
      // Set up: pool has 2 records, but SandboxInfo only has 1 matching org
      mockConnection.query
        // 1st call: prune — fetch all pool records
        .mockResolvedValueOnce({
          records: [
            {Id: 'pool-1', Org_Id__c: '00D000000000001'},
            {Id: 'pool-2', Org_Id__c: '00D000000000002'},
          ],
        })
        // 2nd call: prune — fetch active SandboxInfo
        .mockResolvedValueOnce({
          records: [
            {SandboxOrganization: '00D000000000001'}, // only org 1 exists
          ],
        })
        // 3rd call: getActiveCountByTag query
        .mockResolvedValueOnce({totalSize: 1});

      mockPoolSobject.destroy.mockResolvedValue([{id: 'pool-2', success: true}]);

      const provider = createProvider();
      await provider.getActiveCountByTag('sb-pool');

      // pool-2 should have been pruned
      expect(mockPoolSobject.destroy).toHaveBeenCalledWith(['pool-2']);
    });

    it('should delete pool records with no Org_Id__c', async () => {
      mockConnection.query
        // prune — fetch all pool records
        .mockResolvedValueOnce({
          records: [
            {Id: 'pool-orphan', Org_Id__c: undefined},
          ],
        })
        // getActiveCountByTag
        .mockResolvedValueOnce({totalSize: 0});

      mockPoolSobject.destroy.mockResolvedValue([{id: 'pool-orphan', success: true}]);

      const provider = createProvider();
      await provider.getActiveCountByTag('sb-pool');

      expect(mockPoolSobject.destroy).toHaveBeenCalledWith(['pool-orphan']);
    });

    it('should not prune again within the cooldown period', async () => {
      // First call triggers prune
      mockConnection.query
        .mockResolvedValueOnce({records: []}) // prune — no pool records
        .mockResolvedValueOnce({totalSize: 0}); // getActiveCountByTag

      const provider = createProvider();
      await provider.getActiveCountByTag('sb-pool');

      vi.clearAllMocks();
      setupSobjectRouting();

      // Second call within cooldown should skip prune
      mockConnection.query.mockResolvedValueOnce({totalSize: 2});

      await provider.getActiveCountByTag('sb-pool');

      // Only 1 query (getActiveCountByTag), not 2 (prune + count)
      expect(mockConnection.query).toHaveBeenCalledTimes(1);
    });

    it('should not throw when prune fails', async () => {
      // Prune query fails
      mockConnection.query
        .mockRejectedValueOnce(new Error('API limit exceeded'))
        // getActiveCountByTag succeeds
        .mockResolvedValueOnce({totalSize: 5});

      const provider = createProvider();
      const count = await provider.getActiveCountByTag('sb-pool');

      // Primary operation should still succeed
      expect(count).toBe(5);
    });

    it('should be triggered by getAvailableByTag', async () => {
      mockConnection.query
        .mockResolvedValueOnce({records: []}) // prune — no pool records
        .mockResolvedValueOnce({records: []}); // pool query — no results

      const provider = createProvider();
      await provider.getAvailableByTag('sb-pool');

      // Prune + pool query = 2 queries
      expect(mockConnection.query).toHaveBeenCalledTimes(2);
    });

    it('should be triggered by getOrgsByTag', async () => {
      mockConnection.query
        .mockResolvedValueOnce({records: []}) // prune
        .mockResolvedValueOnce({records: []}); // pool query

      const provider = createProvider();
      await provider.getOrgsByTag('sb-pool');

      expect(mockConnection.query).toHaveBeenCalledTimes(2);
    });

    it('should be triggered by validate', async () => {
      mockConnection.query
        .mockResolvedValueOnce({records: []}); // prune — no pool records

      mockPoolOrgDescribe([
        {name: 'Org_Id__c'},
        {name: 'Tag__c'},
        {
          name: 'Allocation_Status__c',
          picklistValues: [
            {value: 'Allocated'},
            {value: 'Available'},
            {value: 'In Progress'},
          ],
        },
        {name: 'Auth_Url__c'},
      ]);

      const provider = createProvider();
      await provider.validate();

      // Prune query should have fired
      expect(mockConnection.query).toHaveBeenCalledTimes(1);
    });

    it('should skip delete when no stale records found', async () => {
      mockConnection.query
        // prune — pool records
        .mockResolvedValueOnce({
          records: [
            {Id: 'pool-1', Org_Id__c: '00D000000000001'},
          ],
        })
        // prune — SandboxInfo (all match)
        .mockResolvedValueOnce({
          records: [
            {SandboxOrganization: '00D000000000001'},
          ],
        })
        // getActiveCountByTag
        .mockResolvedValueOnce({totalSize: 1});

      const provider = createProvider();
      await provider.getActiveCountByTag('sb-pool');

      // destroy should NOT have been called
      expect(mockPoolSobject.destroy).not.toHaveBeenCalled();
    });
  });

  // --------------------------------------------------------------------------
  // enrichPoolRecords (stale record filtering)
  // --------------------------------------------------------------------------

  describe('stale record filtering in enrichPoolRecords', () => {
    it('should filter out pool records with no matching SandboxInfo', async () => {
      // Pool query returns 2 records, but only 1 has a matching SandboxInfo
      mockConnection.query
        .mockResolvedValueOnce({records: []}) // prune — no pool records
        .mockResolvedValueOnce({
          records: [
            {
              Allocation_Status__c: 'Available',
              Id: 'pool-1',
              Org_Id__c: '00D000000000001',
              Tag__c: 'sb-pool',
            },
            {
              Allocation_Status__c: 'Available',
              Id: 'pool-stale',
              Org_Id__c: '00D000000000099', // deleted sandbox
              Tag__c: 'sb-pool',
            },
          ],
        })
        .mockResolvedValueOnce({
          records: [
            {SandboxName: 'SB1', SandboxOrganization: '00D000000000001'},
            // 00D000000000099 is NOT returned — sandbox was deleted
          ],
        });

      const provider = createProvider();
      const orgs = await provider.getAvailableByTag('sb-pool');

      expect(orgs).toHaveLength(1);
      expect(orgs[0].orgId).toBe('00D000000000001');
    });
  });

});
