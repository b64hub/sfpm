import {
  describe, expect, it, vi,
} from 'vitest';

import type {HookContext} from '@b64/sfpm-core';

import {lwcTailwindHooks} from '../../src/lwc/lwc-tailwind-plugin.js';

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
    operation: 'build',
    packageName: 'test-package',
    timing: 'pre',
    ...overrides,
  };
}

// ============================================================================
// Tests
// ============================================================================

describe('lwcTailwindHooks', () => {
  // --------------------------------------------------------------------------
  // Structure
  // --------------------------------------------------------------------------

  it('should return valid LifecycleHooks', () => {
    const hooks = lwcTailwindHooks();

    expect(hooks.name).toBe('lwc-tailwind');
    expect(hooks.hooks).toHaveLength(1);
    expect(hooks.hooks[0].operation).toBe('build');
    expect(hooks.hooks[0].timing).toBe('pre');
  });

  // --------------------------------------------------------------------------
  // Handler (scaffolded)
  // --------------------------------------------------------------------------

  it('should log info and debug messages for current scaffolded implementation', async () => {
    const hooks = lwcTailwindHooks();
    const logger = createLogger();

    await hooks.hooks[0].handler(createContext({logger}));

    expect(logger.info).toHaveBeenCalledWith(
      expect.stringContaining("generating CSS for 'test-package'"),
    );
    expect(logger.debug).toHaveBeenCalledWith(
      expect.stringContaining("completed for 'test-package'"),
    );
  });

  it('should accept options without error', async () => {
    const hooks = lwcTailwindHooks({
      configPath: 'tailwind.config.js',
      scopeStyles: true,
    });
    const logger = createLogger();

    await expect(
      hooks.hooks[0].handler(createContext({logger})),
    ).resolves.not.toThrow();
  });
});
