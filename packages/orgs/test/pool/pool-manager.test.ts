import {describe, expect, it} from 'vitest';

import {computeOrgAllocation, type PoolAllocation} from '../../src/pool/pool-manager.js';
import {DEFAULT_POOL_SIZING} from '../../src/types.js';

// ============================================================================
// computeOrgAllocation Tests
// ============================================================================

describe('computeOrgAllocation', () => {
  describe('basic allocation scenarios', () => {
    it('should allocate orgs to reach maxAllocation when capacity allows', () => {
      const result = computeOrgAllocation(100, 0, {
        batchSize: 5,
        maxAllocation: 10,
      });

      expect(result).toEqual<PoolAllocation>({
        currentAllocation: 0,
        remaining: 100,
        toAllocate: 10,
        toSatisfyMax: 10,
      });
    });

    it('should allocate only remaining capacity when less than needed', () => {
      const result = computeOrgAllocation(5, 0, {
        batchSize: 10,
        maxAllocation: 20,
      });

      expect(result).toEqual<PoolAllocation>({
        currentAllocation: 0,
        remaining: 5,
        toAllocate: 5,
        toSatisfyMax: 20,
      });
    });

    it('should allocate zero when pool is at max capacity', () => {
      const result = computeOrgAllocation(100, 10, {
        batchSize: 5,
        maxAllocation: 10,
      });

      expect(result).toEqual<PoolAllocation>({
        currentAllocation: 10,
        remaining: 100,
        toAllocate: 0,
        toSatisfyMax: 0,
      });
    });

    it('should allocate zero when DevHub has no remaining capacity', () => {
      const result = computeOrgAllocation(0, 5, {
        batchSize: 10,
        maxAllocation: 20,
      });

      expect(result).toEqual<PoolAllocation>({
        currentAllocation: 5,
        remaining: 0,
        toAllocate: 0,
        toSatisfyMax: 15,
      });
    });
  });

  describe('partial pool scenarios', () => {
    it('should allocate to fill gap when pool is partially filled', () => {
      const result = computeOrgAllocation(50, 7, {
        batchSize: 5,
        maxAllocation: 10,
      });

      expect(result).toEqual<PoolAllocation>({
        currentAllocation: 7,
        remaining: 50,
        toAllocate: 3,
        toSatisfyMax: 3,
      });
    });

    it('should respect remaining capacity over pool gap', () => {
      const result = computeOrgAllocation(2, 8, {
        batchSize: 10,
        maxAllocation: 15,
      });

      expect(result).toEqual<PoolAllocation>({
        currentAllocation: 8,
        remaining: 2,
        toAllocate: 2,
        toSatisfyMax: 7,
      });
    });
  });

  describe('over-allocation scenarios', () => {
    it('should allocate zero when current allocation exceeds max (cleanup needed)', () => {
      const result = computeOrgAllocation(100, 15, {
        batchSize: 5,
        maxAllocation: 10,
      });

      expect(result).toEqual<PoolAllocation>({
        currentAllocation: 15,
        remaining: 100,
        toAllocate: 0,
        toSatisfyMax: 0, // Negative clamped to 0
      });
    });
  });

  describe('edge cases', () => {
    it('should handle zero maxAllocation gracefully', () => {
      const result = computeOrgAllocation(100, 0, {
        batchSize: 5,
        maxAllocation: 0,
      });

      expect(result).toEqual<PoolAllocation>({
        currentAllocation: 0,
        remaining: 100,
        toAllocate: 0,
        toSatisfyMax: 0,
      });
    });

    it('should handle large numbers without overflow', () => {
      const result = computeOrgAllocation(1000, 50, {
        batchSize: 100,
        maxAllocation: 500,
      });

      expect(result).toEqual<PoolAllocation>({
        currentAllocation: 50,
        remaining: 1000,
        toAllocate: 450,
        toSatisfyMax: 450,
      });
    });

    it('should work with default sizing config values', () => {
      const result = computeOrgAllocation(50, 5, {
        ...DEFAULT_POOL_SIZING,
        maxAllocation: 20,
      });

      expect(result.toAllocate).toBeLessThanOrEqual(20 - 5);
      expect(result.toAllocate).toBeLessThanOrEqual(50);
      expect(result.toAllocate).toBe(15); // Should allocate gap to max
    });
  });

  describe('invariants', () => {
    it('toAllocate should never exceed remaining capacity', () => {
      const scenarios = [
        {current: 0, max: 100, remaining: 10},
        {current: 50, max: 100, remaining: 5},
        {current: 0, max: 200, remaining: 50},
      ];

      for (const {current, max, remaining} of scenarios) {
        const result = computeOrgAllocation(remaining, current, {
          batchSize: 10,
          maxAllocation: max,
        });

        expect(result.toAllocate).toBeLessThanOrEqual(remaining);
      }
    });

    it('toAllocate should never exceed toSatisfyMax', () => {
      const scenarios = [
        {current: 5, max: 10, remaining: 100},
        {current: 0, max: 3, remaining: 100},
        {current: 90, max: 100, remaining: 50},
      ];

      for (const {current, max, remaining} of scenarios) {
        const result = computeOrgAllocation(remaining, current, {
          batchSize: 10,
          maxAllocation: max,
        });

        expect(result.toAllocate).toBeLessThanOrEqual(result.toSatisfyMax);
      }
    });

    it('toAllocate should always be non-negative', () => {
      const scenarios = [
        {current: 100, max: 50, remaining: 10}, // Over-allocated
        {current: 0, max: 0, remaining: 0}, // Everything zero
        {current: 10, max: 10, remaining: 0}, // Exactly at capacity
      ];

      for (const {current, max, remaining} of scenarios) {
        const result = computeOrgAllocation(remaining, current, {
          batchSize: 10,
          maxAllocation: max,
        });

        expect(result.toAllocate).toBeGreaterThanOrEqual(0);
      }
    });
  });
});
