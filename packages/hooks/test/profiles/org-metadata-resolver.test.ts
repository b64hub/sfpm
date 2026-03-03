import {describe, it, expect, vi} from 'vitest';
import {Connection} from '@salesforce/core';

import {OrgMetadataResolver} from '../../src/profiles/org-metadata-resolver.js';

// ============================================================================
// Mock Helpers
// ============================================================================

/**
 * Create a mock Connection with stubbed query/describe/metadata methods.
 * Uses Object.create to get a real Connection prototype (for instanceof checks)
 * with vi.fn() stubs on the methods we use.
 */
function createMockConnection(overrides?: {
  query?: ReturnType<typeof vi.fn>;
  describeGlobal?: ReturnType<typeof vi.fn>;
  metadata?: {list: ReturnType<typeof vi.fn>};
}): Connection {
  const conn = Object.create(Connection.prototype) as Connection;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access
  (conn as any).query = overrides?.query ?? vi.fn().mockResolvedValue({records: []});
  // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access
  (conn as any).describeGlobal = overrides?.describeGlobal ?? vi.fn().mockResolvedValue({sobjects: []});
  // metadata is a getter on Connection.prototype — override with defineProperty
  Object.defineProperty(conn, 'metadata', {
    value: overrides?.metadata ?? {list: vi.fn().mockResolvedValue([])},
    writable: true,
  });

  return conn;
}

function createLogger() {
  return {
    debug: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    log: vi.fn(),
    trace: vi.fn(),
    warn: vi.fn(),
  };
}

// ============================================================================
// OrgMetadataResolver
// ============================================================================

describe('OrgMetadataResolver', () => {
  describe('objectPermissions — describeGlobal', () => {
    it('should return SObject names from describeGlobal', async () => {
      const conn = createMockConnection({
        describeGlobal: vi.fn().mockResolvedValue({
          sobjects: [
            {name: 'Account'},
            {name: 'Contact'},
            {name: 'MyCustom__c'},
          ],
        }),
      });

      const resolver = new OrgMetadataResolver(conn);
      const result = await resolver.getOrgComponents('objectPermissions');

      expect(result).toEqual(new Set(['Account', 'Contact', 'MyCustom__c']));
      expect(conn.describeGlobal).toHaveBeenCalledOnce();
    });
  });

  describe('fieldPermissions — FieldDefinition query', () => {
    it('should return qualified Object.Field names', async () => {
      const conn = createMockConnection({
        query: vi.fn().mockResolvedValue({
          records: [
            {QualifiedApiName: 'Name', EntityDefinition: {QualifiedApiName: 'Account'}},
            {QualifiedApiName: 'Email', EntityDefinition: {QualifiedApiName: 'Contact'}},
            {QualifiedApiName: 'Custom__c', EntityDefinition: {QualifiedApiName: 'Account'}},
          ],
        }),
      });

      const resolver = new OrgMetadataResolver(conn);
      const result = await resolver.getOrgComponents('fieldPermissions');

      expect(result).toEqual(new Set([
        'Account.Name',
        'Contact.Email',
        'Account.Custom__c',
      ]));
      expect(conn.query).toHaveBeenCalledWith(
        expect.stringContaining('FieldDefinition'),
      );
    });
  });

  describe('recordTypeVisibilities — RecordType query', () => {
    it('should return qualified Object.RecordType names', async () => {
      const conn = createMockConnection({
        query: vi.fn().mockResolvedValue({
          records: [
            {DeveloperName: 'Business', SobjectType: 'Account'},
            {DeveloperName: 'Personal', SobjectType: 'Contact'},
          ],
        }),
      });

      const resolver = new OrgMetadataResolver(conn);
      const result = await resolver.getOrgComponents('recordTypeVisibilities');

      expect(result).toEqual(new Set([
        'Account.Business',
        'Contact.Personal',
      ]));
    });
  });

  describe('tabVisibilities — TabDefinition + CustomTab', () => {
    it('should return combined standard and custom tab names', async () => {
      const conn = createMockConnection({
        query: vi.fn().mockResolvedValue({
          records: [
            {Name: 'standard-Account'},
            {Name: 'standard-Contact'},
          ],
        }),
        metadata: {
          list: vi.fn().mockResolvedValue([
            {fullName: 'MyCustomTab'},
            {fullName: 'AnotherTab'},
          ]),
        },
      });

      const resolver = new OrgMetadataResolver(conn);
      const result = await resolver.getOrgComponents('tabVisibilities');

      expect(result).toEqual(new Set([
        'standard-Account',
        'standard-Contact',
        'MyCustomTab',
        'AnotherTab',
      ]));
      expect(conn.query).toHaveBeenCalledWith(
        expect.stringContaining('TabDefinition'),
      );
      expect(conn.metadata.list).toHaveBeenCalledWith([{type: 'CustomTab'}]);
    });
  });

  describe('metadata.list-based sections', () => {
    it('should query ApexClass for classAccesses', async () => {
      const conn = createMockConnection({
        metadata: {
          list: vi.fn().mockResolvedValue([
            {fullName: 'MyController'},
            {fullName: 'HelperClass'},
          ]),
        },
      });

      const resolver = new OrgMetadataResolver(conn);
      const result = await resolver.getOrgComponents('classAccesses');

      expect(result).toEqual(new Set(['MyController', 'HelperClass']));
      expect(conn.metadata.list).toHaveBeenCalledWith([{type: 'ApexClass'}]);
    });

    it('should query CustomApplication for applicationVisibilities', async () => {
      const conn = createMockConnection({
        metadata: {
          list: vi.fn().mockResolvedValue([
            {fullName: 'standard__LightningSales'},
            {fullName: 'MyApp'},
          ]),
        },
      });

      const resolver = new OrgMetadataResolver(conn);
      const result = await resolver.getOrgComponents('applicationVisibilities');

      expect(conn.metadata.list).toHaveBeenCalledWith([{type: 'CustomApplication'}]);
      expect(result).toEqual(new Set(['standard__LightningSales', 'MyApp']));
    });

    it('should query ApexPage for pageAccesses', async () => {
      const conn = createMockConnection({
        metadata: {
          list: vi.fn().mockResolvedValue([{fullName: 'MyPage'}]),
        },
      });

      const resolver = new OrgMetadataResolver(conn);
      const result = await resolver.getOrgComponents('pageAccesses');

      expect(conn.metadata.list).toHaveBeenCalledWith([{type: 'ApexPage'}]);
      expect(result.has('MyPage')).toBe(true);
    });

    it('should query Flow for flowAccesses', async () => {
      const conn = createMockConnection({
        metadata: {
          list: vi.fn().mockResolvedValue([{fullName: 'My_Flow'}]),
        },
      });

      const resolver = new OrgMetadataResolver(conn);
      const result = await resolver.getOrgComponents('flowAccesses');

      expect(conn.metadata.list).toHaveBeenCalledWith([{type: 'Flow'}]);
      expect(result.has('My_Flow')).toBe(true);
    });

    it('should query Layout for layoutAssignments', async () => {
      const conn = createMockConnection({
        metadata: {
          list: vi.fn().mockResolvedValue([{fullName: 'Account-Account Layout'}]),
        },
      });

      const resolver = new OrgMetadataResolver(conn);
      const result = await resolver.getOrgComponents('layoutAssignments');

      expect(conn.metadata.list).toHaveBeenCalledWith([{type: 'Layout'}]);
      expect(result.has('Account-Account Layout')).toBe(true);
    });

    it('should query CustomPermission for customPermissions', async () => {
      const conn = createMockConnection({
        metadata: {
          list: vi.fn().mockResolvedValue([{fullName: 'MyPerm'}]),
        },
      });

      const resolver = new OrgMetadataResolver(conn);
      const result = await resolver.getOrgComponents('customPermissions');

      expect(conn.metadata.list).toHaveBeenCalledWith([{type: 'CustomPermission'}]);
      expect(result.has('MyPerm')).toBe(true);
    });

    it('should query ExternalDataSource for externalDataSourceAccesses', async () => {
      const conn = createMockConnection({
        metadata: {
          list: vi.fn().mockResolvedValue([{fullName: 'MySource'}]),
        },
      });

      const resolver = new OrgMetadataResolver(conn);
      const result = await resolver.getOrgComponents('externalDataSourceAccesses');

      expect(conn.metadata.list).toHaveBeenCalledWith([{type: 'ExternalDataSource'}]);
      expect(result.has('MySource')).toBe(true);
    });
  });

  describe('unknown sections', () => {
    it('should return empty set for unmapped sections', async () => {
      const conn = createMockConnection();

      const resolver = new OrgMetadataResolver(conn);
      const result = await resolver.getOrgComponents('unknownSection');

      expect(result.size).toBe(0);
    });
  });

  describe('caching', () => {
    it('should cache results and not re-query the org', async () => {
      const conn = createMockConnection({
        metadata: {
          list: vi.fn().mockResolvedValue([{fullName: 'MyClass'}]),
        },
      });

      const resolver = new OrgMetadataResolver(conn);

      const first = await resolver.getOrgComponents('classAccesses');
      const second = await resolver.getOrgComponents('classAccesses');

      expect(first).toBe(second); // Same reference
      expect(conn.metadata.list).toHaveBeenCalledOnce();
    });

    it('should cache independently per section', async () => {
      const conn = createMockConnection({
        describeGlobal: vi.fn().mockResolvedValue({
          sobjects: [{name: 'Account'}],
        }),
        metadata: {
          list: vi.fn().mockResolvedValue([{fullName: 'MyClass'}]),
        },
      });

      const resolver = new OrgMetadataResolver(conn);

      await resolver.getOrgComponents('objectPermissions');
      await resolver.getOrgComponents('classAccesses');

      expect(conn.describeGlobal).toHaveBeenCalledOnce();
      expect(conn.metadata.list).toHaveBeenCalledOnce();
    });
  });

  describe('error handling', () => {
    it('should return empty set and log warning on query failure', async () => {
      const conn = createMockConnection({
        metadata: {
          list: vi.fn().mockRejectedValue(new Error('Connection timeout')),
        },
      });
      const logger = createLogger();

      const resolver = new OrgMetadataResolver(conn, logger);
      const result = await resolver.getOrgComponents('classAccesses');

      expect(result.size).toBe(0);
      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringContaining('Connection timeout'),
      );
    });

    it('should cache empty set after error (no retry)', async () => {
      const conn = createMockConnection({
        metadata: {
          list: vi.fn().mockRejectedValue(new Error('fail')),
        },
      });

      const resolver = new OrgMetadataResolver(conn);

      await resolver.getOrgComponents('classAccesses');
      await resolver.getOrgComponents('classAccesses');

      expect(conn.metadata.list).toHaveBeenCalledOnce();
    });
  });

  describe('logging', () => {
    it('should log debug messages when querying and receiving results', async () => {
      const conn = createMockConnection({
        metadata: {
          list: vi.fn().mockResolvedValue([{fullName: 'A'}, {fullName: 'B'}]),
        },
      });
      const logger = createLogger();

      const resolver = new OrgMetadataResolver(conn, logger);
      await resolver.getOrgComponents('classAccesses');

      expect(logger.debug).toHaveBeenCalledWith(
        expect.stringContaining("querying org for 'classAccesses'"),
      );
      expect(logger.debug).toHaveBeenCalledWith(
        expect.stringContaining("found 2 'classAccesses' components"),
      );
    });
  });
});
