import {
  beforeEach, describe, expect, it, vi,
} from 'vitest';

import {LifecycleEngine} from '../../src/lifecycle/lifecycle-engine.js';
import type SfpmPackage from '../../src/package/sfpm-package.js';
import {HookContext, LifecycleHooks} from '../../src/types/lifecycle.js';

// ============================================================================
// Test Helpers
// ============================================================================

function createMockPackage(overrides?: Record<string, unknown>): SfpmPackage {
  return {
    name: 'test-package',
    packageDefinition: {},
    type: 'Source',
    ...overrides,
  } as unknown as SfpmPackage;
}

function createContext(overrides?: Partial<HookContext>): HookContext {
  return {
    operation: 'install',
    projectDir: '/project',
    sfpmPackage: createMockPackage(),
    stage: 'local',
    timing: 'pre',
    ...overrides,
  };
}

function createHooks(overrides?: Partial<LifecycleHooks>): LifecycleHooks {
  return {
    hooks: [],
    name: 'test-hooks',
    ...overrides,
  };
}

// ============================================================================
// Tests
// ============================================================================

describe('LifecycleEngine', () => {
  let engine: LifecycleEngine;

  beforeEach(() => {
    LifecycleEngine.resetForTest();
    engine = LifecycleEngine.stage();
  });

  // --------------------------------------------------------------------------
  // Singleton initialization
  // --------------------------------------------------------------------------

  describe('singleton initialization', () => {
    it('should return the same instance when initialized with matching options', () => {
      const first = LifecycleEngine.stage();
      const second = LifecycleEngine.stage();

      expect(second).toBe(first);
    });

    it('should throw when reinitialized with a different stage', () => {
      expect(() => LifecycleEngine.stage('deploy')).toThrow(/already initialized/i);
    });

    it('should throw when getInstance is called before initialize', () => {
      LifecycleEngine.resetForTest();

      expect(() => LifecycleEngine.getInstance()).toThrow(/not initialized/i);
    });
  });

  // --------------------------------------------------------------------------
  // Hook Registration
  // --------------------------------------------------------------------------

  describe('hook registration', () => {
    it('should register lifecycle hooks', () => {
      const handler = vi.fn();
      engine.use(createHooks({
        hooks: [{handler, operation: 'install', timing: 'pre'}],
      }));

      expect(engine.hasHooks('install', 'pre')).toBe(true);
    });

    it('should register multiple hook sets', () => {
      engine.use(createHooks({
        hooks: [{handler: vi.fn(), operation: 'install', timing: 'pre'}],
        name: 'hooks-a',
      }));
      engine.use(createHooks({
        hooks: [{handler: vi.fn(), operation: 'install', timing: 'pre'}],
        name: 'hooks-b',
      }));

      expect(engine.getRegisteredHookNames()).toEqual(['hooks-a', 'hooks-b']);
    });

    it('should return false for hasHooks when none registered', () => {
      expect(engine.hasHooks('install', 'pre')).toBe(false);
    });
  });

  // --------------------------------------------------------------------------
  // Hook Removal
  // --------------------------------------------------------------------------

  describe('hook removal', () => {
    it('should remove hooks by name', () => {
      engine.use(createHooks({
        hooks: [{handler: vi.fn(), operation: 'install', timing: 'pre'}],
        name: 'removable',
      }));

      expect(engine.hasHooks('install', 'pre')).toBe(true);

      const removed = engine.remove('removable');
      expect(removed).toBe(1);
      expect(engine.hasHooks('install', 'pre')).toBe(false);
    });

    it('should return 0 when removing non-existent hooks', () => {
      expect(engine.remove('nonexistent')).toBe(0);
    });

    it('should clear all hooks', () => {
      engine.use(createHooks({
        hooks: [{handler: vi.fn(), operation: 'install', timing: 'pre'}],
        name: 'a',
      }));
      engine.use(createHooks({
        hooks: [{handler: vi.fn(), operation: 'build', timing: 'post'}],
        name: 'b',
      }));

      engine.clear();

      expect(engine.getRegisteredHookNames()).toEqual([]);
      expect(engine.getRegisteredOperations()).toEqual([]);
    });
  });

  // --------------------------------------------------------------------------
  // Hook Execution
  // --------------------------------------------------------------------------

  describe('sequential execution', () => {
    it('should execute hooks in insertion order', async () => {
      const order: number[] = [];

      engine.use(createHooks({
        hooks: [{
          handler() {
            order.push(1);
          },
          operation: 'install',
          timing: 'pre',
        }],
        name: 'first',
      }));
      engine.use(createHooks({
        hooks: [{
          handler() {
            order.push(2);
          },
          operation: 'install',
          timing: 'pre',
        }],
        name: 'second',
      }));
      engine.use(createHooks({
        hooks: [{
          handler() {
            order.push(3);
          },
          operation: 'install',
          timing: 'pre',
        }],
        name: 'third',
      }));

      await engine.run('install', 'pre', createContext());

      expect(order).toEqual([1, 2, 3]);
    });

    it('should await async handlers sequentially', async () => {
      const order: number[] = [];

      engine.use(createHooks({
        hooks: [{
          async handler() {
            await new Promise(resolve => setTimeout(resolve, 20));
            order.push(1);
          },
          operation: 'install',
          timing: 'pre',
        }],
        name: 'slow',
      }));
      engine.use(createHooks({
        hooks: [{
          handler() {
            order.push(2);
          },
          operation: 'install',
          timing: 'pre',
        }],
        name: 'fast',
      }));

      await engine.run('install', 'pre', createContext());

      // Slow finishes first because sequential execution awaits each
      expect(order).toEqual([1, 2]);
    });

    it('should pass context to handlers', async () => {
      const receivedContext = vi.fn();

      engine.use(createHooks({
        hooks: [{handler: receivedContext, operation: 'install', timing: 'pre'}],
      }));

      const context = createContext({sfpmPackage: createMockPackage({name: 'my-pkg'})});
      await engine.run('install', 'pre', context);

      expect(receivedContext).toHaveBeenCalledWith({...context, stage: 'local'});
    });

    it('should throw on first error', async () => {
      const secondHandler = vi.fn();

      engine.use(createHooks({
        hooks: [{
          handler() {
            throw new Error('first failed');
          },
          operation: 'install',
          timing: 'pre',
        }],
        name: 'failing',
      }));
      engine.use(createHooks({
        hooks: [{handler: secondHandler, operation: 'install', timing: 'pre'}],
        name: 'second',
      }));

      await expect(engine.run('install', 'pre', createContext()))
      .rejects.toThrow('first failed');

      // Second handler should not have been called
      expect(secondHandler).not.toHaveBeenCalled();
    });
  });

  // --------------------------------------------------------------------------
  // Ordering
  // --------------------------------------------------------------------------

  describe('ordering', () => {
    it('should respect per-hook order', async () => {
      const order: string[] = [];

      engine.use(createHooks({
        hooks: [{
          handler() {
            order.push('order-last');
          },
          options: {order: 'last'},
          operation: 'install',
          timing: 'pre',
        }],
        name: 'hook-last',
      }));
      engine.use(createHooks({
        hooks: [{
          handler() {
            order.push('order-first');
          },
          options: {order: 'first'},
          operation: 'install',
          timing: 'pre',
        }],
        name: 'hook-first',
      }));
      engine.use(createHooks({
        hooks: [{
          handler() {
            order.push('default');
          },
          operation: 'install',
          timing: 'pre',
        }],
        name: 'default',
      }));

      await engine.run('install', 'pre', createContext());

      expect(order).toEqual(['order-first', 'default', 'order-last']);
    });

    it('should support numeric order for fine-grained control', async () => {
      const order: string[] = [];

      engine.use(createHooks({
        hooks: [{
          handler() { order.push('priority-10'); },
          options: {order: 10},
          operation: 'install',
          timing: 'pre',
        }],
        name: 'p10',
      }));
      engine.use(createHooks({
        hooks: [{
          handler() { order.push('priority-neg5'); },
          options: {order: -5},
          operation: 'install',
          timing: 'pre',
        }],
        name: 'p-5',
      }));
      engine.use(createHooks({
        hooks: [{
          handler() { order.push('default'); },
          operation: 'install',
          timing: 'pre',
        }],
        name: 'default',
      }));
      engine.use(createHooks({
        hooks: [{
          handler() { order.push('first'); },
          options: {order: 'first'},
          operation: 'install',
          timing: 'pre',
        }],
        name: 'first',
      }));
      engine.use(createHooks({
        hooks: [{
          handler() { order.push('last'); },
          options: {order: 'last'},
          operation: 'install',
          timing: 'pre',
        }],
        name: 'last',
      }));

      await engine.run('install', 'pre', createContext());

      expect(order).toEqual(['first', 'priority-neg5', 'default', 'priority-10', 'last']);
    });

    it('should preserve insertion order within same priority', async () => {
      const order: string[] = [];

      engine.use(createHooks({
        hooks: [{
          handler() {
            order.push('a');
          },
          operation: 'install',
          timing: 'pre',
        }],
        name: 'a',
      }));
      engine.use(createHooks({
        hooks: [{
          handler() {
            order.push('b');
          },
          operation: 'install',
          timing: 'pre',
        }],
        name: 'b',
      }));
      engine.use(createHooks({
        hooks: [{
          handler() {
            order.push('c');
          },
          operation: 'install',
          timing: 'pre',
        }],
        name: 'c',
      }));

      await engine.run('install', 'pre', createContext());

      expect(order).toEqual(['a', 'b', 'c']);
    });
  });

  // --------------------------------------------------------------------------
  // Filtering
  // --------------------------------------------------------------------------

  describe('filtering', () => {
    it('should skip hooks when filter returns false', async () => {
      const handler = vi.fn();

      engine.use(createHooks({
        hooks: [{
          handler,
          options: {filter: ctx => ctx.sfpmPackage.type === 'Unlocked'},
          operation: 'install',
          timing: 'pre',
        }],
      }));

      // Source package — should be filtered out
      await engine.run('install', 'pre', createContext({sfpmPackage: createMockPackage({type: 'Source'})}));
      expect(handler).not.toHaveBeenCalled();

      // Unlocked package — should pass filter
      await engine.run('install', 'pre', createContext({sfpmPackage: createMockPackage({type: 'Unlocked'})}));
      expect(handler).toHaveBeenCalledTimes(1);
    });

    it('should only filter matching hooks, not all hooks', async () => {
      const filteredHandler = vi.fn();
      const unfilteredHandler = vi.fn();

      engine.use(createHooks({
        hooks: [{
          handler: filteredHandler,
          options: {filter: () => false},
          operation: 'install',
          timing: 'pre',
        }],
        name: 'filtered',
      }));
      engine.use(createHooks({
        hooks: [{handler: unfilteredHandler, operation: 'install', timing: 'pre'}],
        name: 'unfiltered',
      }));

      await engine.run('install', 'pre', createContext());

      expect(filteredHandler).not.toHaveBeenCalled();
      expect(unfilteredHandler).toHaveBeenCalledTimes(1);
    });
  });

  // --------------------------------------------------------------------------
  // Operation-agnostic execution
  // --------------------------------------------------------------------------

  describe('operation-agnostic execution', () => {
    it('should run hooks for any operation:timing without prior registration', async () => {
      const handler = vi.fn();

      engine.use(createHooks({
        hooks: [{handler, operation: 'custom-operation', timing: 'custom-timing' as any}],
      }));

      await engine.run('custom-operation', 'custom-timing', createContext({
        operation: 'custom-operation' as any,
        timing: 'custom-timing' as any,
      }));

      expect(handler).toHaveBeenCalledTimes(1);
    });
  });

  // --------------------------------------------------------------------------
  // No-op when no hooks registered
  // --------------------------------------------------------------------------

  describe('no-op behavior', () => {
    it('should not throw when no hooks match', async () => {
      // No hooks registered — run should complete silently
      await expect(engine.run('install', 'pre', createContext())).resolves.toBeUndefined();
    });

    it('should not throw when hooks exist for different operation:timing', async () => {
      engine.use(createHooks({
        hooks: [{handler: vi.fn(), operation: 'build', timing: 'pre'}],
      }));

      // Run install:pre — no hooks registered for it
      await expect(engine.run('install', 'pre', createContext())).resolves.toBeUndefined();
    });
  });

  // --------------------------------------------------------------------------
  // Introspection
  // --------------------------------------------------------------------------

  describe('introspection', () => {
    it('should report registered operations', () => {
      engine.use(createHooks({
        hooks: [
          {handler: vi.fn(), operation: 'build', timing: 'pre'},
          {handler: vi.fn(), operation: 'install', timing: 'post'},
        ],
      }));

      const operations = engine.getRegisteredOperations();
      expect(operations).toContain('build');
      expect(operations).toContain('install');
      expect(operations).toHaveLength(2);
    });

    it('should report registered hook names', () => {
      engine.use(createHooks({
        hooks: [{handler: vi.fn(), operation: 'build', timing: 'pre'}],
        name: 'alpha',
      }));
      engine.use(createHooks({
        hooks: [{handler: vi.fn(), operation: 'install', timing: 'pre'}],
        name: 'beta',
      }));

      expect(engine.getRegisteredHookNames()).toEqual(['alpha', 'beta']);
    });

    it('should return empty arrays when no hooks registered', () => {
      expect(engine.getRegisteredOperations()).toEqual([]);
      expect(engine.getRegisteredHookNames()).toEqual([]);
    });
  });

  // --------------------------------------------------------------------------
  // Logger Integration
  // --------------------------------------------------------------------------

  describe('logging', () => {
    it('should log debug messages via context logger', async () => {
      const logger = {
        debug: vi.fn(),
        error: vi.fn(),
        info: vi.fn(),
        log: vi.fn(),
        trace: vi.fn(),
        warn: vi.fn(),
      };

      engine.use(createHooks({
        hooks: [{handler: vi.fn(), operation: 'install', timing: 'pre'}],
        name: 'test-hooks',
      }));

      await engine.run('install', 'pre', createContext({logger}));

      // Should log execution via context logger
      expect(logger.debug).toHaveBeenCalledWith(expect.stringContaining("running 1 hook(s) for 'install:pre'"));
    });

    it('should execute shorthand run and hasHooks methods for build/install timings', async () => {
      const buildPre = vi.fn();
      const buildPost = vi.fn();
      const installPre = vi.fn();
      const installPost = vi.fn();

      engine.use(createHooks({
        hooks: [
          {handler: buildPre, operation: 'build', timing: 'pre'},
          {handler: buildPost, operation: 'build', timing: 'post'},
          {handler: installPre, operation: 'install', timing: 'pre'},
          {handler: installPost, operation: 'install', timing: 'post'},
        ],
        name: 'shorthands',
      }));

      expect(engine.hasBuildPreHooks()).toBe(true);
      expect(engine.hasBuildPostHooks()).toBe(true);
      expect(engine.hasInstallPreHooks()).toBe(true);
      expect(engine.hasInstallPostHooks()).toBe(true);

      await engine.runBuildPre(createContext({operation: 'build', timing: 'pre'}));
      await engine.runBuildPost(createContext({operation: 'build', timing: 'post'}));
      await engine.runInstallPre(createContext({operation: 'install', timing: 'pre'}));
      await engine.runInstallPost(createContext({operation: 'install', timing: 'post'}));

      expect(buildPre).toHaveBeenCalledTimes(1);
      expect(buildPost).toHaveBeenCalledTimes(1);
      expect(installPre).toHaveBeenCalledTimes(1);
      expect(installPost).toHaveBeenCalledTimes(1);
    });
  });
});
