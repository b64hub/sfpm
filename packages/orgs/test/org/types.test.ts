import {describe, expect, it} from 'vitest';

import {AllocationStatus, OrgError} from '../../src/org/types.js';

// ============================================================================
// AllocationStatus Tests
// ============================================================================

describe('AllocationStatus', () => {
  it('should define all expected statuses', () => {
    expect(AllocationStatus.Allocated).toBe('Allocated');
    expect(AllocationStatus.Assigned).toBe('Assigned');
    expect(AllocationStatus.Available).toBe('Available');
    expect(AllocationStatus.InProgress).toBe('In Progress');
    expect(AllocationStatus.Return).toBe('Return');
  });
});

// ============================================================================
// OrgError Tests
// ============================================================================

describe('OrgError', () => {
  describe('construction', () => {
    it('should create an error with operation and message', () => {
      const error = new OrgError('create', 'Scratch org creation failed');

      expect(error).toBeInstanceOf(Error);
      expect(error).toBeInstanceOf(OrgError);
      expect(error.name).toBe('OrgError');
      expect(error.message).toBe('Scratch org creation failed');
      expect(error.operation).toBe('create');
      expect(error.timestamp).toBeInstanceOf(Date);
      expect(error.context).toEqual({});
      expect(error.orgIdentifier).toBeUndefined();
    });

    it('should accept an orgIdentifier', () => {
      const error = new OrgError('fetch', 'No orgs available', {
        orgIdentifier: 'test@scratch.org',
      });

      expect(error.orgIdentifier).toBe('test@scratch.org');
    });

    it('should accept a context object', () => {
      const error = new OrgError('prerequisite', 'Missing field', {
        context: {field: 'Tag__c', sobject: 'ScratchOrgInfo'},
      });

      expect(error.context).toEqual({field: 'Tag__c', sobject: 'ScratchOrgInfo'});
    });

    it('should preserve the cause chain', () => {
      const cause = new Error('Connection refused');
      const error = new OrgError('auth', 'Authentication failed', {
        cause,
        orgIdentifier: 'user@test.org',
      });

      expect(error.cause).toBe(cause);
    });

    it('should handle cause without stack gracefully', () => {
      const cause = new Error('No stack');
      cause.stack = undefined;
      const error = new OrgError('auth', 'Auth failed', {cause});

      expect(error.cause).toBe(cause);
    });

    it('should support all valid operation types', () => {
      const operations: OrgError['operation'][] = [
        'auth', 'create', 'delete', 'fetch', 'password', 'prerequisite', 'share', 'update',
      ];

      for (const op of operations) {
        const error = new OrgError(op, `${op} failed`);
        expect(error.operation).toBe(op);
      }
    });
  });

  describe('toDisplayMessage', () => {
    it('should format message with operation', () => {
      const error = new OrgError('create', 'API limit exceeded');
      const display = error.toDisplayMessage();

      expect(display).toContain('Org create failed');
      expect(display).toContain('API limit exceeded');
    });

    it('should include org identifier when present', () => {
      const error = new OrgError('fetch', 'Timeout', {
        orgIdentifier: 'myOrg@test.com',
      });
      const display = error.toDisplayMessage();

      expect(display).toContain('Org: myOrg@test.com');
    });

    it('should include cause message when present', () => {
      const cause = new Error('ETIMEDOUT');
      const error = new OrgError('auth', 'Login failed', {cause});
      const display = error.toDisplayMessage();

      expect(display).toContain('Cause: ETIMEDOUT');
    });

    it('should omit cause line when no cause', () => {
      const error = new OrgError('delete', 'Record not found');
      const display = error.toDisplayMessage();

      expect(display).not.toContain('Cause:');
    });
  });

  describe('toJSON', () => {
    it('should serialize to a plain object', () => {
      const error = new OrgError('create', 'Failed to create org', {
        context: {tag: 'dev-pool'},
        orgIdentifier: 'org@test.com',
      });

      const json = error.toJSON();

      expect(json.type).toBe('OrgError');
      expect(json.operation).toBe('create');
      expect(json.message).toBe('Failed to create org');
      expect(json.orgIdentifier).toBe('org@test.com');
      expect(json.context).toEqual({tag: 'dev-pool'});
      expect(json.timestamp).toBeDefined();
      expect(json.cause).toBeUndefined();
    });

    it('should include cause info when present', () => {
      const cause = new Error('SOQL limit');
      cause.name = 'SalesforceError';
      const error = new OrgError('fetch', 'Query failed', {cause});

      const json = error.toJSON();

      expect(json.cause).toEqual({
        message: 'SOQL limit',
        name: 'SalesforceError',
      });
    });

    it('should produce a JSON-serializable object', () => {
      const error = new OrgError('update', 'Update failed', {
        cause: new Error('Lock contention'),
        context: {recordId: '001xxx'},
        orgIdentifier: 'user@org.com',
      });

      const serialized = JSON.stringify(error.toJSON());
      const parsed = JSON.parse(serialized);

      expect(parsed.operation).toBe('update');
      expect(parsed.message).toBe('Update failed');
    });
  });
});
