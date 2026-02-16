import {
  beforeEach, describe, expect, it, vi,
} from 'vitest';

import type {
  PoolConfig, PoolDeleteOptions, PoolOrgTask, PoolOrgTaskResult,
} from '../../src/types.js';

import PoolManager from '../../src/pool/pool-manager.js';

// ============================================================================
// Test Helpers
// ============================================================================

function createMockOrgService() {
  return {
    createScratchOrg: vi.fn(),
    deleteScratchOrgs: vi.fn(),
    emit: vi.fn(),
    on: vi.fn(),
  };
}

function createMockPoolInfo() {
  return {
    getActiveCountByTag: vi.fn(),
    getRecordIds: vi.fn(),
    getRemainingCapacity: vi.fn(),
    getScratchOrgInfoByUsername: vi.fn(),
    getScratchOrgUsageByUser: vi.fn(),
    getUserEmail: vi.fn(),
    getUsername: vi.fn().mockReturnValue('devhub@example.com'),
    isOrgActive: vi.fn(),
    sendEmail: vi.fn(),
    updatePoolMetadata: vi.fn(),
  };
}

function createMockPoolOrgSource() {
  return {
    claimOrg: vi.fn(),
    getAvailableByTag: vi.fn(),
    getOrgsByTag: vi.fn(),
    getRecordIds: vi.fn(),
    setAlias: vi.fn(),
    setUserPassword: vi.fn(),
    updatePoolMetadata: vi.fn(),
  };
}

function createPoolConfig(overrides?: Partial<PoolConfig>): PoolConfig {
  return {
    scratchOrg: {
      definitionFile: 'config/project-scratch-def.json',
      expiryDays: 7,
      ...overrides?.scratchOrg,
    },
    sizing: {
      batchSize: 2,
      maxAllocation: 5,
      ...overrides?.sizing,
    },
    tag: 'test-pool',
    ...overrides,
  };
}

function createScratchOrg(overrides?: Record<string, unknown>) {
  return {
    alias: 'SO1',
    orgId: '00D000000000001',
    recordId: 'a00000000000001',
    username: `test-${Math.random().toString(36).slice(2, 8)}@scratch.org`,
    ...overrides,
  };
}

function createMockTask(name: string, result?: Partial<PoolOrgTaskResult>): PoolOrgTask {
  return {
    continueOnError: false,
    execute: vi.fn().mockResolvedValue({success: true, ...result}),
    name,
  };
}

// ============================================================================
// PoolManager Tests
// ============================================================================

describe('PoolManager', () => {
  let orgService: ReturnType<typeof createMockOrgService>;
  let poolInfo: ReturnType<typeof createMockPoolInfo>;
  let poolOrgSource: ReturnType<typeof createMockPoolOrgSource>;

  beforeEach(() => {
    orgService = createMockOrgService();
    poolInfo = createMockPoolInfo();
    poolOrgSource = createMockPoolOrgSource();
  });

  // ==========================================================================
  // computeAllocation
  // ==========================================================================

  describe('computeAllocation', () => {
    it('should query remaining capacity and active count', async () => {
      poolInfo.getRemainingCapacity.mockResolvedValue(100);
      poolInfo.getActiveCountByTag.mockResolvedValue(3);

      const manager = new PoolManager({orgService: orgService as any, poolInfo: poolInfo as any});
      const config = createPoolConfig({sizing: {batchSize: 5, maxAllocation: 10}});

      const result = await manager.computeAllocation(config);

      expect(poolInfo.getRemainingCapacity).toHaveBeenCalled();
      expect(poolInfo.getActiveCountByTag).toHaveBeenCalledWith('test-pool');
      expect(result.toAllocate).toBe(7); // 10 - 3 = 7, min(7, 100)
      expect(result.remaining).toBe(100);
      expect(result.currentAllocation).toBe(3);
    });

    it('should emit pool:allocation:computed event', async () => {
      poolInfo.getRemainingCapacity.mockResolvedValue(50);
      poolInfo.getActiveCountByTag.mockResolvedValue(5);

      const manager = new PoolManager({orgService: orgService as any, poolInfo: poolInfo as any});
      const events: any[] = [];
      manager.on('pool:allocation:computed', e => events.push(e));

      await manager.computeAllocation(createPoolConfig());

      expect(events).toHaveLength(1);
      expect(events[0].tag).toBe('test-pool');
      expect(events[0].toAllocate).toBe(0); // 5 = maxAllocation
    });
  });

  // ==========================================================================
  // provision
  // ==========================================================================

  describe('provision', () => {
    it('should return zero-allocation result when pool is full', async () => {
      poolInfo.getRemainingCapacity.mockResolvedValue(100);
      poolInfo.getActiveCountByTag.mockResolvedValue(5); // maxAllocation = 5

      const manager = new PoolManager({orgService: orgService as any, poolInfo: poolInfo as any});
      const result = await manager.provision(createPoolConfig());

      expect(result.succeeded).toEqual([]);
      expect(result.failed).toBe(0);
      expect(result.tag).toBe('test-pool');
      expect(orgService.createScratchOrg).not.toHaveBeenCalled();
    });

    it('should return zero-allocation result when no DevHub capacity', async () => {
      poolInfo.getRemainingCapacity.mockResolvedValue(0);
      poolInfo.getActiveCountByTag.mockResolvedValue(0);

      const manager = new PoolManager({orgService: orgService as any, poolInfo: poolInfo as any});
      const result = await manager.provision(createPoolConfig());

      expect(result.succeeded).toEqual([]);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]).toContain('No remaining scratch org capacity');
    });

    it('should create scratch orgs and validate them', async () => {
      poolInfo.getRemainingCapacity.mockResolvedValue(100);
      poolInfo.getActiveCountByTag.mockResolvedValue(0);

      const org1 = createScratchOrg({username: 'org1@scratch.org'});
      const org2 = createScratchOrg({username: 'org2@scratch.org'});

      orgService.createScratchOrg
      .mockResolvedValueOnce(org1)
      .mockResolvedValueOnce(org2);

      poolInfo.isOrgActive.mockResolvedValue(true);
      poolInfo.getRecordIds.mockImplementation((orgs: any[]) => orgs);
      poolInfo.updatePoolMetadata.mockResolvedValue();

      const manager = new PoolManager({orgService: orgService as any, poolInfo: poolInfo as any});
      const config = createPoolConfig({sizing: {batchSize: 5, maxAllocation: 2}});
      const result = await manager.provision(config);

      expect(orgService.createScratchOrg).toHaveBeenCalledTimes(2);
      expect(poolInfo.isOrgActive).toHaveBeenCalledTimes(2);
      expect(result.succeeded).toHaveLength(2);
      expect(result.failed).toBe(0);
    });

    it('should handle partial failures during creation', async () => {
      poolInfo.getRemainingCapacity.mockResolvedValue(100);
      poolInfo.getActiveCountByTag.mockResolvedValue(0);

      const org1 = createScratchOrg({username: 'org1@scratch.org'});
      orgService.createScratchOrg
      .mockResolvedValueOnce(org1)
      .mockRejectedValueOnce(new Error('Creation timed out'));

      poolInfo.isOrgActive.mockResolvedValue(true);
      poolInfo.getRecordIds.mockImplementation((orgs: any[]) => orgs);
      poolInfo.updatePoolMetadata.mockResolvedValue();

      const manager = new PoolManager({orgService: orgService as any, poolInfo: poolInfo as any});
      const config = createPoolConfig({sizing: {batchSize: 5, maxAllocation: 2}});
      const result = await manager.provision(config);

      expect(result.succeeded).toHaveLength(1);
      expect(result.failed).toBe(1);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]).toContain('timed out');
    });

    it('should throw when all creation attempts fail', async () => {
      poolInfo.getRemainingCapacity.mockResolvedValue(100);
      poolInfo.getActiveCountByTag.mockResolvedValue(0);

      orgService.createScratchOrg.mockRejectedValue(new Error('API limit'));

      const manager = new PoolManager({orgService: orgService as any, poolInfo: poolInfo as any});
      const config = createPoolConfig({sizing: {batchSize: 5, maxAllocation: 2}});

      await expect(manager.provision(config)).rejects.toThrow('All scratch org provisioning attempts failed');
    });

    it('should discard orgs that fail validation', async () => {
      poolInfo.getRemainingCapacity.mockResolvedValue(100);
      poolInfo.getActiveCountByTag.mockResolvedValue(0);

      const org1 = createScratchOrg({username: 'active@scratch.org'});
      const org2 = createScratchOrg({username: 'deleted@scratch.org'});

      orgService.createScratchOrg
      .mockResolvedValueOnce(org1)
      .mockResolvedValueOnce(org2);

      poolInfo.isOrgActive
      .mockResolvedValueOnce(true) // org1 is active
      .mockResolvedValueOnce(false); // org2 was silently deleted

      poolInfo.getRecordIds.mockImplementation((orgs: any[]) => orgs);
      poolInfo.updatePoolMetadata.mockResolvedValue();

      const manager = new PoolManager({orgService: orgService as any, poolInfo: poolInfo as any});
      const config = createPoolConfig({sizing: {batchSize: 5, maxAllocation: 2}});
      const result = await manager.provision(config);

      expect(result.succeeded).toHaveLength(1);
      expect(result.succeeded[0].username).toBe('active@scratch.org');
    });

    it('should throw when all orgs fail validation', async () => {
      poolInfo.getRemainingCapacity.mockResolvedValue(100);
      poolInfo.getActiveCountByTag.mockResolvedValue(0);

      orgService.createScratchOrg.mockResolvedValue(createScratchOrg());
      poolInfo.isOrgActive.mockResolvedValue(false);

      const manager = new PoolManager({orgService: orgService as any, poolInfo: poolInfo as any});
      const config = createPoolConfig({sizing: {batchSize: 5, maxAllocation: 1}});

      await expect(manager.provision(config)).rejects.toThrow('All provisioned orgs were found to be inactive');
    });

    it('should register orgs in pool with correct metadata', async () => {
      poolInfo.getRemainingCapacity.mockResolvedValue(100);
      poolInfo.getActiveCountByTag.mockResolvedValue(0);

      const org = createScratchOrg({
        password: 'pw123',
        recordId: 'rec-id',
        username: 'meta@scratch.org',
      });
      orgService.createScratchOrg.mockResolvedValue(org);
      poolInfo.isOrgActive.mockResolvedValue(true);
      poolInfo.getRecordIds.mockImplementation((orgs: any[]) => orgs);
      poolInfo.updatePoolMetadata.mockResolvedValue();

      const manager = new PoolManager({orgService: orgService as any, poolInfo: poolInfo as any});
      const config = createPoolConfig({sizing: {batchSize: 5, maxAllocation: 1}});
      await manager.provision(config);

      expect(poolInfo.updatePoolMetadata).toHaveBeenCalledWith(expect.arrayContaining([
        expect.objectContaining({
          allocationStatus: 'In Progress',
          id: 'rec-id',
          poolTag: 'test-pool',
        }),
      ]));
    });

    it('should emit provision start and complete events', async () => {
      poolInfo.getRemainingCapacity.mockResolvedValue(100);
      poolInfo.getActiveCountByTag.mockResolvedValue(0);

      const org = createScratchOrg();
      orgService.createScratchOrg.mockResolvedValue(org);
      poolInfo.isOrgActive.mockResolvedValue(true);
      poolInfo.getRecordIds.mockImplementation((orgs: any[]) => orgs);
      poolInfo.updatePoolMetadata.mockResolvedValue();

      const manager = new PoolManager({orgService: orgService as any, poolInfo: poolInfo as any});
      const events: string[] = [];
      manager.on('pool:provision:start', () => events.push('start'));
      manager.on('pool:provision:complete', () => events.push('complete'));

      await manager.provision(createPoolConfig({sizing: {batchSize: 5, maxAllocation: 1}}));

      expect(events).toEqual(['start', 'complete']);
    });

    it('should respect batch concurrency (sequential batches)', async () => {
      poolInfo.getRemainingCapacity.mockResolvedValue(100);
      poolInfo.getActiveCountByTag.mockResolvedValue(0);

      // Track timing of create calls
      const callOrder: number[] = [];
      orgService.createScratchOrg.mockImplementation(async () => {
        callOrder.push(Date.now());
        return createScratchOrg();
      });
      poolInfo.isOrgActive.mockResolvedValue(true);
      poolInfo.getRecordIds.mockImplementation((orgs: any[]) => orgs);
      poolInfo.updatePoolMetadata.mockResolvedValue();

      const manager = new PoolManager({orgService: orgService as any, poolInfo: poolInfo as any});
      // 4 orgs with batchSize 2 = 2 batches
      const config = createPoolConfig({sizing: {batchSize: 2, maxAllocation: 4}});
      await manager.provision(config);

      expect(orgService.createScratchOrg).toHaveBeenCalledTimes(4);
    });
  });

  // ==========================================================================
  // provision — task execution
  // ==========================================================================

  describe('provision with tasks', () => {
    beforeEach(() => {
      poolInfo.getRemainingCapacity.mockResolvedValue(100);
      poolInfo.getActiveCountByTag.mockResolvedValue(0);
      poolInfo.isOrgActive.mockResolvedValue(true);
      poolInfo.getRecordIds.mockImplementation((orgs: any[]) => orgs);
      poolInfo.updatePoolMetadata.mockResolvedValue();
    });

    it('should run tasks on each provisioned org', async () => {
      const org = createScratchOrg();
      orgService.createScratchOrg.mockResolvedValue(org);

      const task = createMockTask('deploy');
      const manager = new PoolManager({
        orgService: orgService as any,
        poolInfo: poolInfo as any,
        tasks: [task],
      });

      const result = await manager.provision(createPoolConfig({sizing: {batchSize: 5, maxAllocation: 1}}));

      expect(task.execute).toHaveBeenCalledTimes(1);
      expect(result.taskResults).toHaveLength(1);
      expect(result.taskResults![0].success).toBe(true);
    });

    it('should run tasks in order per org', async () => {
      const org = createScratchOrg();
      orgService.createScratchOrg.mockResolvedValue(org);

      const executionOrder: string[] = [];
      const task1: PoolOrgTask = {
        continueOnError: false,
        execute: vi.fn().mockImplementation(async () => {
          executionOrder.push('task1');
          return {success: true};
        }),
        name: 'deploy',
      };
      const task2: PoolOrgTask = {
        continueOnError: false,
        execute: vi.fn().mockImplementation(async () => {
          executionOrder.push('task2');
          return {success: true};
        }),
        name: 'script',
      };

      const manager = new PoolManager({
        orgService: orgService as any,
        poolInfo: poolInfo as any,
        tasks: [task1, task2],
      });

      await manager.provision(createPoolConfig({sizing: {batchSize: 5, maxAllocation: 1}}));

      expect(executionOrder).toEqual(['task1', 'task2']);
    });

    it('should abort remaining tasks when a task fails (continueOnError=false)', async () => {
      const org = createScratchOrg();
      orgService.createScratchOrg.mockResolvedValue(org);

      const failTask = createMockTask('deploy', {error: 'Deploy failed', success: false});
      const skipTask = createMockTask('script');

      const manager = new PoolManager({
        orgService: orgService as any,
        poolInfo: poolInfo as any,
        tasks: [failTask, skipTask],
      });

      const result = await manager.provision(createPoolConfig({sizing: {batchSize: 5, maxAllocation: 1}}));

      expect(failTask.execute).toHaveBeenCalled();
      expect(skipTask.execute).not.toHaveBeenCalled();
      expect(result.taskResults![0].success).toBe(false);
      expect(result.taskResults![0].results[1].error).toContain('Skipped');
    });

    it('should continue remaining tasks when continueOnError=true', async () => {
      const org = createScratchOrg();
      orgService.createScratchOrg.mockResolvedValue(org);

      const failTask: PoolOrgTask = {
        continueOnError: true,
        execute: vi.fn().mockResolvedValue({error: 'Nonfatal', success: false}),
        name: 'optional-step',
      };
      const nextTask = createMockTask('script');

      const manager = new PoolManager({
        orgService: orgService as any,
        poolInfo: poolInfo as any,
        tasks: [failTask, nextTask],
      });

      const result = await manager.provision(createPoolConfig({sizing: {batchSize: 5, maxAllocation: 1}}));

      expect(nextTask.execute).toHaveBeenCalled();
      expect(result.taskResults![0].success).toBe(false); // overall org fails (first task failed)
    });

    it('should handle task execution errors gracefully', async () => {
      const org = createScratchOrg();
      orgService.createScratchOrg.mockResolvedValue(org);

      const crashingTask: PoolOrgTask = {
        continueOnError: false,
        execute: vi.fn().mockRejectedValue(new Error('Uncaught exception')),
        name: 'crash',
      };

      const manager = new PoolManager({
        orgService: orgService as any,
        poolInfo: poolInfo as any,
        tasks: [crashingTask],
      });

      const result = await manager.provision(createPoolConfig({sizing: {batchSize: 5, maxAllocation: 1}}));

      // Should not throw; error is captured in task results
      expect(result.taskResults![0].success).toBe(false);
      expect(result.taskResults![0].results[0].error).toContain('Uncaught exception');
    });

    it('should emit task events', async () => {
      const org = createScratchOrg({username: 'task-org@scratch.org'});
      orgService.createScratchOrg.mockResolvedValue(org);

      const task = createMockTask('deploy');
      const manager = new PoolManager({
        orgService: orgService as any,
        poolInfo: poolInfo as any,
        tasks: [task],
      });

      const taskEvents: string[] = [];
      manager.on('pool:task:start', () => taskEvents.push('start'));
      manager.on('pool:task:complete', () => taskEvents.push('complete'));

      await manager.provision(createPoolConfig({sizing: {batchSize: 5, maxAllocation: 1}}));

      expect(taskEvents).toEqual(['start', 'complete']);
    });

    it('should call loggerFactory.dispose after tasks complete', async () => {
      const org = createScratchOrg();
      orgService.createScratchOrg.mockResolvedValue(org);

      const loggerFactory = {
        create: vi.fn().mockReturnValue({
          debug: vi.fn(), error: vi.fn(), info: vi.fn(), log: vi.fn(), trace: vi.fn(), warn: vi.fn(),
        }),
        dispose: vi.fn(),
      };

      const manager = new PoolManager({
        loggerFactory,
        orgService: orgService as any,
        poolInfo: poolInfo as any,
        tasks: [createMockTask('deploy')],
      });

      await manager.provision(createPoolConfig({sizing: {batchSize: 5, maxAllocation: 1}}));

      expect(loggerFactory.dispose).toHaveBeenCalled();
    });
  });

  // ==========================================================================
  // delete
  // ==========================================================================

  describe('delete', () => {
    it('should throw when poolOrgSource is not provided', async () => {
      const manager = new PoolManager({orgService: orgService as any, poolInfo: poolInfo as any});

      await expect(manager.delete({tag: 'test-pool'})).rejects.toThrow('PoolOrgSource is required for delete operations');
    });

    it('should return empty result when no orgs match', async () => {
      poolOrgSource.getOrgsByTag.mockResolvedValue([]);

      const manager = new PoolManager({
        orgService: orgService as any,
        poolInfo: poolInfo as any,
        poolOrgSource: poolOrgSource as any,
      });

      const result = await manager.delete({tag: 'empty-pool'});

      expect(result.deleted).toEqual([]);
      expect(result.errors).toEqual([]);
      expect(result.tag).toBe('empty-pool');
    });

    it('should delete orgs with valid recordIds', async () => {
      const org1 = createScratchOrg({recordId: 'rec-1', username: 'del1@scratch.org'});
      const org2 = createScratchOrg({recordId: 'rec-2', username: 'del2@scratch.org'});
      poolOrgSource.getOrgsByTag.mockResolvedValue([org1, org2]);
      orgService.deleteScratchOrgs.mockResolvedValue();

      const manager = new PoolManager({
        orgService: orgService as any,
        poolInfo: poolInfo as any,
        poolOrgSource: poolOrgSource as any,
      });

      const result = await manager.delete({tag: 'test-pool'});

      expect(orgService.deleteScratchOrgs).toHaveBeenCalledTimes(2);
      expect(result.deleted).toHaveLength(2);
    });

    it('should skip orgs without recordIds', async () => {
      const orgNoId = createScratchOrg({recordId: undefined, username: 'noid@scratch.org'});
      poolOrgSource.getOrgsByTag.mockResolvedValue([orgNoId]);

      const manager = new PoolManager({
        orgService: orgService as any,
        poolInfo: poolInfo as any,
        poolOrgSource: poolOrgSource as any,
      });

      const result = await manager.delete({tag: 'test-pool'});

      expect(orgService.deleteScratchOrgs).not.toHaveBeenCalled();
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]).toContain('no recordId');
    });

    it('should filter by inProgressOnly', async () => {
      const org1 = createScratchOrg({recordId: 'r1', status: 'In Progress', username: 'ip@scratch.org'});
      const org2 = createScratchOrg({recordId: 'r2', status: 'Available', username: 'av@scratch.org'});
      poolOrgSource.getOrgsByTag.mockResolvedValue([org1, org2]);
      orgService.deleteScratchOrgs.mockResolvedValue();

      const manager = new PoolManager({
        orgService: orgService as any,
        poolInfo: poolInfo as any,
        poolOrgSource: poolOrgSource as any,
      });

      const result = await manager.delete({inProgressOnly: true, tag: 'test-pool'});

      expect(orgService.deleteScratchOrgs).toHaveBeenCalledTimes(1);
      expect(result.deleted).toHaveLength(1);
      expect(result.deleted[0].username).toBe('ip@scratch.org');
    });

    it('should handle deletion errors for individual orgs', async () => {
      const org1 = createScratchOrg({recordId: 'ok', username: 'ok@scratch.org'});
      const org2 = createScratchOrg({recordId: 'fail', username: 'fail@scratch.org'});
      poolOrgSource.getOrgsByTag.mockResolvedValue([org1, org2]);
      orgService.deleteScratchOrgs
      .mockResolvedValueOnce()
      .mockRejectedValueOnce(new Error('DELETE_FAILED'));

      const manager = new PoolManager({
        orgService: orgService as any,
        poolInfo: poolInfo as any,
        poolOrgSource: poolOrgSource as any,
      });

      const result = await manager.delete({tag: 'test-pool'});

      expect(result.deleted).toHaveLength(1);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]).toContain('DELETE_FAILED');
    });

    it('should pass myPool flag to getOrgsByTag', async () => {
      poolOrgSource.getOrgsByTag.mockResolvedValue([]);

      const manager = new PoolManager({
        orgService: orgService as any,
        poolInfo: poolInfo as any,
        poolOrgSource: poolOrgSource as any,
      });

      await manager.delete({myPool: true, tag: 'test-pool'});

      expect(poolOrgSource.getOrgsByTag).toHaveBeenCalledWith('test-pool', true);
    });

    it('should emit delete start and complete events', async () => {
      const org = createScratchOrg({recordId: 'rec-1'});
      poolOrgSource.getOrgsByTag.mockResolvedValue([org]);
      orgService.deleteScratchOrgs.mockResolvedValue();

      const manager = new PoolManager({
        orgService: orgService as any,
        poolInfo: poolInfo as any,
        poolOrgSource: poolOrgSource as any,
      });

      const events: string[] = [];
      manager.on('pool:delete:start', () => events.push('start'));
      manager.on('pool:delete:complete', () => events.push('complete'));
      manager.on('pool:org:deleted', () => events.push('deleted'));

      await manager.delete({tag: 'test-pool'});

      expect(events).toEqual(['start', 'deleted', 'complete']);
    });
  });
});
