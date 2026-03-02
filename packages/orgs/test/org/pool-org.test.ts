import {describe, expect, it} from 'vitest';
import {OrgTypes} from '@salesforce/core';

import type {Sandbox} from '../../src/org/sandbox/types.js';
import type {ScratchOrg} from '../../src/org/scratch/types.js';

import {isSandbox, isScratchOrg} from '../../src/org/pool-org.js';
import type {PoolOrg} from '../../src/org/pool-org.js';
import {AllocationStatus} from '../../src/org/types.js';

// ============================================================================
// Test Fixtures
// ============================================================================

function createSandbox(overrides?: Partial<Sandbox>): Sandbox {
  return {
    auth: {username: 'user@prod.sb1'},
    orgId: '00D000000000001',
    orgType: OrgTypes.Sandbox,
    ...overrides,
  };
}

function createScratchOrg(overrides?: Partial<ScratchOrg>): ScratchOrg {
  return {
    auth: {username: 'test@scratch.org'},
    orgId: '00D000000000002',
    orgType: OrgTypes.Scratch,
    ...overrides,
  };
}

// ============================================================================
// Tests
// ============================================================================

describe('pool-org type guards', () => {
  describe('isSandbox', () => {
    it('should return true for a Sandbox', () => {
      const org: PoolOrg = createSandbox();
      expect(isSandbox(org)).toBe(true);
    });

    it('should return false for a ScratchOrg', () => {
      const org: PoolOrg = createScratchOrg();
      expect(isSandbox(org)).toBe(false);
    });

    it('should narrow the type to Sandbox', () => {
      const org: PoolOrg = createSandbox({pool: {groupId: 'grp1', status: AllocationStatus.Available, tag: 'sb-pool', timestamp: Date.now()}});
      if (isSandbox(org)) {
        // This should compile — groupId exists on Sandbox.pool
        expect(org.pool?.groupId).toBe('grp1');
      }
    });
  });

  describe('isScratchOrg', () => {
    it('should return true for a ScratchOrg', () => {
      const org: PoolOrg = createScratchOrg();
      expect(isScratchOrg(org)).toBe(true);
    });

    it('should return false for a Sandbox', () => {
      const org: PoolOrg = createSandbox();
      expect(isScratchOrg(org)).toBe(false);
    });

    it('should narrow the type to ScratchOrg', () => {
      const org: PoolOrg = createScratchOrg({recordId: 'rec-123'});
      if (isScratchOrg(org)) {
        expect(org.orgType).toBe(OrgTypes.Scratch);
        expect(org.recordId).toBe('rec-123');
      }
    });
  });
});
