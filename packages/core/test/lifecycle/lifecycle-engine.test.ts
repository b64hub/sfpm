import {
  beforeEach, describe, expect, it, vi,
} from 'vitest';

import {LifecycleEngine} from '../../src/lifecycle/lifecycle-engine.js';
import {HookContext, LifecycleHooks} from '../../src/types/lifecycle.js';

// ============================================================================
// Test Helpers
// ============================================================================

function createContext(overrides?: Partial<HookContext>): HookContext {
  return {
    packageName: 'test-package',
    packageType: 'Source',
    operation: 'install',
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
    engine = new LifecycleEngine();
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
            await new Promise(r => setTimeout(r, 20));
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

      const context = createContext({packageName: 'my-pkg'});
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
  // Ordering — enforce + order
  // --------------------------------------------------------------------------

  describe('ordering', () => {
    it('should respect enforce ordering', async () => {
      const order: string[] = [];

      engine.use(createHooks({
        hooks: [{
          handler() {
            order.push('normal');
          },
          operation: 'install',
          timing: 'pre',
        }],
        name: 'normal',
      }));
      engine.use(createHooks({
        enforce: 'pre',
        hooks: [{
          handler() {
            order.push('enforce-pre');
          },
          operation: 'install',
          timing: 'pre',
        }],
        name: 'pre-hooks',
      }));
      engine.use(createHooks({
        enforce: 'post',
        hooks: [{
          handler() {
            order.push('enforce-post');
          },
          operation: 'install',
          timing: 'pre',
        }],
        name: 'post-hooks',
      }));

      await engine.run('install', 'pre', createContext());

      expect(order).toEqual(['enforce-pre', 'normal', 'enforce-post']);
    });

    it('should respect per-hook order within enforce group', async () => {
      const order: string[] = [];

      engine.use(createHooks({
        hooks: [{
          handler() {
            order.push('order-post');
          },
          options: {order: 'post'},
          operation: 'install',
          timing: 'pre',
        }],
        name: 'hook-post',
      }));
      engine.use(createHooks({
        hooks: [{
          handler() {
            order.push('order-pre');
          },
          options: {order: 'pre'},
          operation: 'install',
          timing: 'pre',
        }],
        name: 'hook-pre',
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

      expect(order).toEqual(['order-pre', 'default', 'order-post']);
    });

    it('should combine enforce and order for full priority chain', async () => {
      const order: string[] = [];

      // enforce:post + order:pre
      engine.use(createHooks({
        enforce: 'post',
        hooks: [{
          handler() {
            order.push('enforce-post:order-pre');
          },
          options: {order: 'pre'},
          operation: 'install',
          timing: 'pre',
        }],
        name: 'ep-op',
      }));

      // enforce:pre + order:post
      engine.use(createHooks({
        enforce: 'pre',
        hooks: [{
          handler() {
            order.push('enforce-pre:order-post');
          },
          options: {order: 'post'},
          operation: 'install',
          timing: 'pre',
        }],
        name: 'ep-op2',
      }));

      // default enforce + default order
      engine.use(createHooks({
        hooks: [{
          handler() {
            order.push('default:default');
          },
          operation: 'install',
          timing: 'pre',
        }],
        name: 'dd',
      }));

      await engine.run('install', 'pre', createContext());

      expect(order).toEqual([
        'enforce-pre:order-post',   // enforce:pre comes first, even with order:post
        'default:default',           // normal hooks
        'enforce-post:order-pre',    // enforce:post comes last, even with order:pre
      ]);
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
          options: {filter: ctx => ctx.packageType === 'Unlocked'},
          operation: 'install',
          timing: 'pre',
        }],
      }));

      // Source package — should be filtered out
      await engine.run('install', 'pre', createContext({packageType: 'Source'}));
      expect(handler).not.toHaveBeenCalled();

      // Unlocked package — should pass filter
      await engine.run('install', 'pre', createContext({packageType: 'Unlocked'}));
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
        hooks: [{handler, operation: 'custom-operation', timing: 'custom-timing'}],
      }));

      await engine.run('custom-operation', 'custom-timing', createContext({
        operation: 'custom-operation',
        timing: 'custom-timing',
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
    it('should log debug messages with logger', async () => {
      const logger = {
        debug: vi.fn(),
        error: vi.fn(),
        info: vi.fn(),
        log: vi.fn(),
        trace: vi.fn(),
        warn: vi.fn(),
      };

      const loggedEngine = new LifecycleEngine({logger});

      loggedEngine.use(createHooks({
        hooks: [{handler: vi.fn(), operation: 'install', timing: 'pre'}],
        name: 'test-hooks',
      }));

      await loggedEngine.run('install', 'pre', createContext());

      // Should log registration
      expect(logger.debug).toHaveBeenCalledWith(expect.stringContaining("registered 'test-hooks'"));
      // Should log execution
      expect(logger.debug).toHaveBeenCalledWith(expect.stringContaining("running 1 hook(s) for 'install:pre'"));
    });
  });
});
