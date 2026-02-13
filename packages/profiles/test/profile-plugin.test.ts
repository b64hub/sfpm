import {describe, it, expect, vi} from 'vitest';

import type {HookContext} from '@b64/sfpm-core';

import {profileHooks} from '../src/profile-plugin.js';

function createContext(overrides?: Partial<HookContext>): HookContext {
  return {
    packageName: 'test-package',
    packageType: 'Source',
    phase: 'install',
    timing: 'pre',
    ...overrides,
  };
}

describe('profileHooks', () => {
  it('should return valid LifecycleHooks', () => {
    const hooks = profileHooks();

    expect(hooks.name).toBe('profiles');
    expect(hooks.hooks).toBeDefined();
    expect(hooks.hooks).toHaveLength(1);
    expect(hooks.hooks[0].phase).toBe('install');
    expect(hooks.hooks[0].timing).toBe('pre');
    expect(hooks.hooks[0].handler).toBeTypeOf('function');
  });

  it('should accept custom options', () => {
    const hooks = profileHooks({
      reconcile: false,
      removeLoginIpRanges: true,
    });

    expect(hooks.name).toBe('profiles');
    expect(hooks.hooks).toHaveLength(1);
  });

  it('should skip when no package path is available', async () => {
    const hooks = profileHooks();
    const handler = hooks.hooks[0].handler;

    const logger = {
      debug: vi.fn(),
      error: vi.fn(),
      info: vi.fn(),
      log: vi.fn(),
      trace: vi.fn(),
      warn: vi.fn(),
    };

    const context = createContext({logger});

    await handler(context);

    expect(logger.debug).toHaveBeenCalledWith(
      expect.stringContaining('no package path'),
    );
  });
});
