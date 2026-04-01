import {
  describe, expect, it, vi,
} from 'vitest';

import type {HookContext} from '@b64/sfpm-core';

import {browserforceHooks} from '../../src/browserforce/browserforce-plugin.js';

// ============================================================================
// Test Helpers
// ============================================================================

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

function createContext(overrides?: Partial<HookContext>): HookContext {
  return {
    operation: 'install',
    packageName: 'test-package',
    timing: 'post',
    ...overrides,
  };
}

// ============================================================================
// Tests
// ============================================================================

describe('browserforceHooks', () => {
  // --------------------------------------------------------------------------
  // Structure
  // --------------------------------------------------------------------------

  it('should return valid LifecycleHooks', () => {
    const hooks = browserforceHooks({planFile: 'plan.json'});

    expect(hooks.name).toBe('browserforce');
    expect(hooks.hooks).toHaveLength(1);
    expect(hooks.hooks[0].operation).toBe('install');
    expect(hooks.hooks[0].timing).toBe('post');
  });

  // --------------------------------------------------------------------------
  // Package name filter
  // --------------------------------------------------------------------------

  it('should skip when packageName filter does not match', async () => {
    const hooks = browserforceHooks({packageName: 'other-package', planFile: 'plan.json'});
    const logger = createLogger();

    await hooks.hooks[0].handler(createContext({
      logger,
      packageName: 'test-package',
    }));

    expect(logger.debug).toHaveBeenCalledWith(
      expect.stringContaining('filter does not match'),
    );
  });

  it('should run when packageName filter matches', async () => {
    const hooks = browserforceHooks({packageName: 'test-package', planFile: 'plan.json'});
    const logger = createLogger();

    await hooks.hooks[0].handler(createContext({
      logger,
      packageName: 'test-package',
    }));

    expect(logger.info).toHaveBeenCalledWith(
      expect.stringContaining("applying plan for 'test-package'"),
    );
  });

  it('should run for all packages when no packageName filter', async () => {
    const hooks = browserforceHooks({planFile: 'plan.json'});
    const logger = createLogger();

    await hooks.hooks[0].handler(createContext({
      logger,
      packageName: 'any-package',
    }));

    expect(logger.info).toHaveBeenCalledWith(
      expect.stringContaining('applying plan'),
    );
  });
});
