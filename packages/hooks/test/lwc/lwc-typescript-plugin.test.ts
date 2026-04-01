import {
  beforeEach, describe, expect, it, vi,
} from 'vitest';

import type {HookContext} from '@b64/sfpm-core';

import {lwcTypescriptHooks} from '../../src/lwc/lwc-typescript-plugin.js';

// ============================================================================
// Mocks
// ============================================================================

vi.mock('node:fs', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:fs')>();
  return {
    ...original,
    existsSync: vi.fn().mockReturnValue(false),
    readdirSync: vi.fn().mockReturnValue([]),
    statSync: vi.fn().mockReturnValue({isDirectory: () => false}),
    unlinkSync: vi.fn(),
  };
});

vi.mock('node:child_process', () => ({
  spawn: vi.fn(),
}));

import {existsSync, readdirSync, statSync, unlinkSync} from 'node:fs';
import {spawn} from 'node:child_process';

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

/**
 * Create a mock spawn that resolves with given exit code.
 */
function mockSpawnSuccess() {
  const on = vi.fn();
  const child = {
    on,
    stderr: {on: vi.fn()},
    stdout: {on: vi.fn()},
  };

  vi.mocked(spawn).mockReturnValue(child as any);

  // Simulate close event on next tick
  on.mockImplementation((event: string, cb: (...args: any[]) => void) => {
    if (event === 'close') {
      setTimeout(() => cb(0), 0);
    }
  });

  return child;
}

function mockSpawnFailure(output = 'compilation error') {
  const on = vi.fn();
  const stderrOn = vi.fn();
  const child = {
    on,
    stderr: {on: stderrOn},
    stdout: {on: vi.fn()},
  };

  vi.mocked(spawn).mockReturnValue(child as any);

  stderrOn.mockImplementation((event: string, cb: (data: Buffer) => void) => {
    if (event === 'data') {
      setTimeout(() => cb(Buffer.from(output)), 0);
    }
  });

  on.mockImplementation((event: string, cb: (...args: any[]) => void) => {
    if (event === 'close') {
      setTimeout(() => cb(1), 5);
    }
  });

  return child;
}

// ============================================================================
// Tests
// ============================================================================

describe('lwcTypescriptHooks', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // --------------------------------------------------------------------------
  // Structure
  // --------------------------------------------------------------------------

  it('should return valid LifecycleHooks', () => {
    const hooks = lwcTypescriptHooks();

    expect(hooks.name).toBe('lwc-typescript');
    expect(hooks.hooks).toHaveLength(1);
    expect(hooks.hooks[0].operation).toBe('build');
    expect(hooks.hooks[0].timing).toBe('pre');
  });

  // --------------------------------------------------------------------------
  // Guards
  // --------------------------------------------------------------------------

  it('should skip when no package directory', async () => {
    const hooks = lwcTypescriptHooks();
    const logger = createLogger();

    await hooks.hooks[0].handler(createContext({
      logger,
      sfpmPackage: {},
    }));

    expect(logger.debug).toHaveBeenCalledWith(
      expect.stringContaining('no package directory'),
    );
  });

  it('should skip when no sfpmPackage', async () => {
    const hooks = lwcTypescriptHooks();
    const logger = createLogger();

    await hooks.hooks[0].handler(createContext({logger}));

    expect(logger.debug).toHaveBeenCalledWith(
      expect.stringContaining('no package directory'),
    );
  });

  it('should skip when no lwc directory found', async () => {
    vi.mocked(existsSync).mockReturnValue(false);

    const hooks = lwcTypescriptHooks();
    const logger = createLogger();

    await hooks.hooks[0].handler(createContext({
      logger,
      sfpmPackage: {packageDirectory: '/pkg/dir'},
    }));

    expect(logger.debug).toHaveBeenCalledWith(
      expect.stringContaining('no lwc directory'),
    );
  });

  it('should skip when no .ts files found in lwc directory', async () => {
    vi.mocked(existsSync).mockImplementation((p: any) =>
      String(p).includes('lwc'));

    vi.mocked(readdirSync).mockReturnValue([] as any);

    const hooks = lwcTypescriptHooks();
    const logger = createLogger();

    await hooks.hooks[0].handler(createContext({
      logger,
      sfpmPackage: {packageDirectory: '/pkg/dir'},
    }));

    expect(logger.debug).toHaveBeenCalledWith(
      expect.stringContaining('no .ts files'),
    );
  });

  // --------------------------------------------------------------------------
  // File collection
  // --------------------------------------------------------------------------

  describe('file collection', () => {
    it('should collect .ts files but not .d.ts', async () => {
      vi.mocked(existsSync).mockImplementation((p: any) =>
        String(p).includes('lwc'));

      vi.mocked(readdirSync).mockImplementation((dir: any) => {
        const d = String(dir);
        if (d.endsWith('lwc')) return ['myComponent'] as any;
        if (d.endsWith('myComponent')) return ['controller.ts', 'types.d.ts', 'helper.js'] as any;
        return [] as any;
      });

      vi.mocked(statSync).mockImplementation((p: any) => {
        const path = String(p);
        return {
          isDirectory: () => path.endsWith('myComponent'),
        } as any;
      });

      mockSpawnSuccess();

      const hooks = lwcTypescriptHooks();
      const logger = createLogger();

      await hooks.hooks[0].handler(createContext({
        logger,
        sfpmPackage: {packageDirectory: '/pkg/dir'},
      }));

      expect(logger.info).toHaveBeenCalledWith(
        expect.stringContaining('compiling 1 TypeScript file(s)'),
      );
    });

    it('should skip __tests__ directories', async () => {
      vi.mocked(existsSync).mockImplementation((p: any) =>
        String(p).includes('lwc'));

      vi.mocked(readdirSync).mockImplementation((dir: any) => {
        const d = String(dir);
        if (d.endsWith('lwc')) return ['comp', '__tests__'] as any;
        if (d.endsWith('comp')) return ['file.ts'] as any;
        if (d.endsWith('__tests__')) return ['test.ts'] as any;
        return [] as any;
      });

      vi.mocked(statSync).mockImplementation((p: any) => {
        const path = String(p);
        return {
          isDirectory: () => path.endsWith('comp') || path.endsWith('__tests__'),
        } as any;
      });

      mockSpawnSuccess();

      const hooks = lwcTypescriptHooks();
      const logger = createLogger();

      await hooks.hooks[0].handler(createContext({
        logger,
        sfpmPackage: {packageDirectory: '/pkg/dir'},
      }));

      // Only 1 file from 'comp', not the one from '__tests__'
      expect(logger.info).toHaveBeenCalledWith(
        expect.stringContaining('compiling 1 TypeScript file(s)'),
      );
    });
  });

  // --------------------------------------------------------------------------
  // tsc invocation
  // --------------------------------------------------------------------------

  describe('tsc invocation', () => {
    it('should spawn tsc via npx', async () => {
      vi.mocked(existsSync).mockImplementation((p: any) =>
        String(p).includes('lwc'));

      vi.mocked(readdirSync).mockReturnValue(['file.ts'] as any);
      vi.mocked(statSync).mockReturnValue({isDirectory: () => false} as any);

      mockSpawnSuccess();

      const hooks = lwcTypescriptHooks();
      const logger = createLogger();

      await hooks.hooks[0].handler(createContext({
        logger,
        sfpmPackage: {packageDirectory: '/pkg/dir'},
      }));

      expect(spawn).toHaveBeenCalledWith(
        'npx',
        ['tsc'],
        expect.objectContaining({cwd: expect.stringContaining('lwc')}),
      );
    });

    it('should pass tsconfig option', async () => {
      vi.mocked(existsSync).mockImplementation((p: any) =>
        String(p).includes('lwc'));

      vi.mocked(readdirSync).mockReturnValue(['file.ts'] as any);
      vi.mocked(statSync).mockReturnValue({isDirectory: () => false} as any);

      mockSpawnSuccess();

      const hooks = lwcTypescriptHooks({tsconfig: 'tsconfig.lwc.json'});
      const logger = createLogger();

      await hooks.hooks[0].handler(createContext({
        logger,
        sfpmPackage: {packageDirectory: '/pkg/dir'},
      }));

      expect(spawn).toHaveBeenCalledWith(
        'npx',
        ['tsc', '--project', 'tsconfig.lwc.json'],
        expect.any(Object),
      );
    });

    it('should throw on tsc failure', async () => {
      vi.mocked(existsSync).mockImplementation((p: any) =>
        String(p).includes('lwc'));

      vi.mocked(readdirSync).mockReturnValue(['file.ts'] as any);
      vi.mocked(statSync).mockReturnValue({isDirectory: () => false} as any);

      mockSpawnFailure('TS2322: Type error');

      const hooks = lwcTypescriptHooks();
      const logger = createLogger();

      await expect(
        hooks.hooks[0].handler(createContext({
          logger,
          sfpmPackage: {packageDirectory: '/pkg/dir'},
        })),
      ).rejects.toThrow('compilation failed');
    });
  });

  // --------------------------------------------------------------------------
  // Source file removal
  // --------------------------------------------------------------------------

  describe('source file removal', () => {
    it('should remove .ts files after compilation by default', async () => {
      vi.mocked(existsSync).mockImplementation((p: any) =>
        String(p).includes('lwc'));

      vi.mocked(readdirSync).mockImplementation((dir: any) => {
        const d = String(dir);
        if (d.endsWith('lwc')) return ['comp'] as any;
        if (d.endsWith('comp')) return ['file.ts'] as any;
        return [] as any;
      });

      vi.mocked(statSync).mockImplementation((p: any) => ({
        isDirectory: () => String(p).endsWith('comp'),
      }) as any);

      mockSpawnSuccess();

      const hooks = lwcTypescriptHooks();
      const logger = createLogger();

      await hooks.hooks[0].handler(createContext({
        logger,
        sfpmPackage: {packageDirectory: '/pkg/dir'},
      }));

      expect(unlinkSync).toHaveBeenCalledTimes(1);
      expect(unlinkSync).toHaveBeenCalledWith(
        expect.stringContaining('file.ts'),
      );
    });

    it('should not remove .ts files when removeSourceFiles is false', async () => {
      vi.mocked(existsSync).mockImplementation((p: any) =>
        String(p).includes('lwc'));

      vi.mocked(readdirSync).mockImplementation((dir: any) => {
        const d = String(dir);
        if (d.endsWith('lwc')) return ['comp'] as any;
        if (d.endsWith('comp')) return ['file.ts'] as any;
        return [] as any;
      });

      vi.mocked(statSync).mockImplementation((p: any) => ({
        isDirectory: () => String(p).endsWith('comp'),
      }) as any);

      mockSpawnSuccess();

      const hooks = lwcTypescriptHooks({removeSourceFiles: false});
      const logger = createLogger();

      await hooks.hooks[0].handler(createContext({
        logger,
        sfpmPackage: {packageDirectory: '/pkg/dir'},
      }));

      expect(unlinkSync).not.toHaveBeenCalled();
    });
  });
});
