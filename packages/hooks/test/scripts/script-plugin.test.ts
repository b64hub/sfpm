import {
  beforeEach, describe, expect, it, vi,
} from 'vitest';

import type {HookContext} from '@b64/sfpm-core';
import {resolveHookConfig} from '@b64/sfpm-core';
import {Org} from '@salesforce/core';

import {scriptHooks} from '../../src/scripts/script-plugin.js';

// ============================================================================
// Mocks
// ============================================================================

vi.mock('@b64/sfpm-core', async (importOriginal) => {
  const original = await importOriginal<typeof import('@b64/sfpm-core')>();
  return {
    ...original,
    resolveHookConfig: vi.fn().mockReturnValue({config: {}, enabled: true}),
  };
});

vi.mock('../../src/scripts/script-runner.js', () => ({
  ScriptRunner: vi.fn().mockImplementation(function() { return {
    run: vi.fn().mockResolvedValue({exitCode: 0, stderr: '', stdout: '', success: true}),
  }; }),
}));

import {ScriptRunner} from '../../src/scripts/script-runner.js';

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

function createMockOrg(username = 'test@user.org') {
  const org = Object.create(Org.prototype);
  org.getConnection = vi.fn().mockReturnValue({});
  org.getUsername = vi.fn().mockReturnValue(username);
  return org as Org;
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

describe('scriptHooks', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(resolveHookConfig).mockReturnValue({config: {}, enabled: true});
  });

  // --------------------------------------------------------------------------
  // Structure
  // --------------------------------------------------------------------------

  it('should return valid LifecycleHooks', () => {
    const hooks = scriptHooks({scripts: []});

    expect(hooks.name).toBe('scripts');
    expect(hooks.hooks).toHaveLength(2);
    expect(hooks.hooks[0].operation).toBe('install');
    expect(hooks.hooks[0].timing).toBe('pre');
    expect(hooks.hooks[1].operation).toBe('install');
    expect(hooks.hooks[1].timing).toBe('post');
  });

  // --------------------------------------------------------------------------
  // Pre hook
  // --------------------------------------------------------------------------

  describe('install:pre handler', () => {
    it('should skip when no pre scripts', async () => {
      const hooks = scriptHooks({scripts: []});
      const logger = createLogger();

      await hooks.hooks[0].handler(createContext({logger, org: createMockOrg(), timing: 'pre'}));

      expect(ScriptRunner).not.toHaveBeenCalled();
    });

    it('should run pre-timed global scripts', async () => {
      vi.mocked(ScriptRunner).mockImplementation(function() { return {
        run: vi.fn().mockResolvedValue({exitCode: 0, stderr: '', stdout: '', success: true}),
      }; } as any);

      const hooks = scriptHooks({
        scripts: [{path: 'scripts/setup.sh', timing: 'pre'}],
      });
      const logger = createLogger();

      await hooks.hooks[0].handler(createContext({
        logger,
        org: createMockOrg(),
        timing: 'pre',
      }));

      const instance = vi.mocked(ScriptRunner).mock.results[0].value;
      expect(instance.run).toHaveBeenCalledWith(
        expect.objectContaining({path: 'scripts/setup.sh'}),
        'shell',
        expect.objectContaining({targetOrg: 'test@user.org'}),
        expect.any(String),
      );
    });
  });

  // --------------------------------------------------------------------------
  // Post hook
  // --------------------------------------------------------------------------

  describe('install:post handler', () => {
    it('should run post-timed global scripts', async () => {
      vi.mocked(ScriptRunner).mockImplementation(function() { return {
        run: vi.fn().mockResolvedValue({exitCode: 0, stderr: '', stdout: '', success: true}),
      }; } as any);

      const hooks = scriptHooks({
        scripts: [{path: 'scripts/deploy.ts', timing: 'post'}],
      });
      const logger = createLogger();

      await hooks.hooks[1].handler(createContext({
        logger,
        org: createMockOrg(),
        timing: 'post',
      }));

      const instance = vi.mocked(ScriptRunner).mock.results[0].value;
      expect(instance.run).toHaveBeenCalledWith(
        expect.objectContaining({path: 'scripts/deploy.ts'}),
        'typescript',
        expect.any(Object),
        expect.any(String),
      );
    });

    it('should default to post timing when not specified', async () => {
      vi.mocked(ScriptRunner).mockImplementation(function() { return {
        run: vi.fn().mockResolvedValue({exitCode: 0, stderr: '', stdout: '', success: true}),
      }; } as any);

      const hooks = scriptHooks({
        scripts: [{path: 'scripts/seed.apex'}],
      });
      const logger = createLogger();

      // The script has no timing, defaults to post
      await hooks.hooks[1].handler(createContext({
        logger,
        org: createMockOrg(),
        timing: 'post',
      }));

      const instance = vi.mocked(ScriptRunner).mock.results[0].value;
      expect(instance.run).toHaveBeenCalledWith(
        expect.objectContaining({path: 'scripts/seed.apex'}),
        'apex',
        expect.any(Object),
        expect.any(String),
      );
    });

    it('should merge per-package overrides with global scripts', async () => {
      vi.mocked(resolveHookConfig).mockReturnValue({
        config: {post: ['scripts/pkg-specific.sh']},
        enabled: true,
      });

      vi.mocked(ScriptRunner).mockImplementation(function() { return {
        run: vi.fn().mockResolvedValue({exitCode: 0, stderr: '', stdout: '', success: true}),
      }; } as any);

      const hooks = scriptHooks({
        scripts: [{path: 'scripts/global.sh', timing: 'post'}],
      });
      const logger = createLogger();

      await hooks.hooks[1].handler(createContext({
        logger,
        org: createMockOrg(),
        timing: 'post',
      }));

      const instance = vi.mocked(ScriptRunner).mock.results[0].value;
      // Both global and per-package scripts should run
      expect(instance.run).toHaveBeenCalledTimes(2);
    });
  });

  // --------------------------------------------------------------------------
  // Script type inference
  // --------------------------------------------------------------------------

  describe('script type inference', () => {
    it.each([
      ['.sh', 'shell'],
      ['.ts', 'typescript'],
      ['.js', 'javascript'],
      ['.apex', 'apex'],
    ])('should infer %s as %s', async (ext, expectedType) => {
      vi.mocked(ScriptRunner).mockImplementation(function() { return {
        run: vi.fn().mockResolvedValue({exitCode: 0, stderr: '', stdout: '', success: true}),
      }; } as any);

      const hooks = scriptHooks({
        scripts: [{path: `scripts/test${ext}`, timing: 'post'}],
      });
      const logger = createLogger();

      await hooks.hooks[1].handler(createContext({logger, org: createMockOrg(), timing: 'post'}));

      const instance = vi.mocked(ScriptRunner).mock.results[0].value;
      expect(instance.run).toHaveBeenCalledWith(
        expect.any(Object),
        expectedType,
        expect.any(Object),
        expect.any(String),
      );
    });

    it('should throw for unknown extension', async () => {
      const hooks = scriptHooks({
        scripts: [{path: 'scripts/run.unknown', timing: 'post'}],
      });
      const logger = createLogger();

      await expect(
        hooks.hooks[1].handler(createContext({logger, org: createMockOrg(), timing: 'post'})),
      ).rejects.toThrow('unable to infer script type');
    });

    it('should use explicit type over inferred', async () => {
      vi.mocked(ScriptRunner).mockImplementation(function() { return {
        run: vi.fn().mockResolvedValue({exitCode: 0, stderr: '', stdout: '', success: true}),
      }; } as any);

      const hooks = scriptHooks({
        scripts: [{path: 'scripts/run.sh', timing: 'post', type: 'apex'}],
      });
      const logger = createLogger();

      await hooks.hooks[1].handler(createContext({logger, org: createMockOrg(), timing: 'post'}));

      const instance = vi.mocked(ScriptRunner).mock.results[0].value;
      expect(instance.run).toHaveBeenCalledWith(
        expect.any(Object),
        'apex',
        expect.any(Object),
        expect.any(String),
      );
    });
  });

  // --------------------------------------------------------------------------
  // Filtering
  // --------------------------------------------------------------------------

  describe('filtering', () => {
    it('should skip scripts filtered by packageName', async () => {
      vi.mocked(ScriptRunner).mockImplementation(function() { return {
        run: vi.fn().mockResolvedValue({exitCode: 0, stderr: '', stdout: '', success: true}),
      }; } as any);

      const hooks = scriptHooks({
        scripts: [{packageName: 'other-package', path: 'scripts/run.sh', timing: 'post'}],
      });
      const logger = createLogger();

      await hooks.hooks[1].handler(createContext({
        logger,
        org: createMockOrg(),
        packageName: 'test-package',
        timing: 'post',
      }));

      const instance = vi.mocked(ScriptRunner).mock.results[0].value;
      expect(instance.run).not.toHaveBeenCalled();
    });

    it('should skip scripts filtered by stage', async () => {
      vi.mocked(ScriptRunner).mockImplementation(function() { return {
        run: vi.fn().mockResolvedValue({exitCode: 0, stderr: '', stdout: '', success: true}),
      }; } as any);

      const hooks = scriptHooks({
        scripts: [{path: 'scripts/run.sh', stages: ['deploy'], timing: 'post'}],
      });
      const logger = createLogger();

      await hooks.hooks[1].handler(createContext({
        logger,
        org: createMockOrg(),
        stage: 'validate',
        timing: 'post',
      }));

      const instance = vi.mocked(ScriptRunner).mock.results[0].value;
      expect(instance.run).not.toHaveBeenCalled();
    });

    it('should run script when stage matches', async () => {
      vi.mocked(ScriptRunner).mockImplementation(function() { return {
        run: vi.fn().mockResolvedValue({exitCode: 0, stderr: '', stdout: '', success: true}),
      }; } as any);

      const hooks = scriptHooks({
        scripts: [{path: 'scripts/run.sh', stages: ['deploy', 'local'], timing: 'post'}],
      });
      const logger = createLogger();

      await hooks.hooks[1].handler(createContext({
        logger,
        org: createMockOrg(),
        stage: 'deploy',
        timing: 'post',
      }));

      const instance = vi.mocked(ScriptRunner).mock.results[0].value;
      expect(instance.run).toHaveBeenCalled();
    });
  });

  // --------------------------------------------------------------------------
  // Error handling
  // --------------------------------------------------------------------------

  describe('error handling', () => {
    it('should throw on script failure when failOnError is true (default)', async () => {
      vi.mocked(ScriptRunner).mockImplementation(function() { return {
        run: vi.fn().mockResolvedValue({exitCode: 1, stderr: 'bad stuff', stdout: '', success: false}),
      }; } as any);

      const hooks = scriptHooks({
        scripts: [{path: 'scripts/run.sh', timing: 'post'}],
      });
      const logger = createLogger();

      await expect(
        hooks.hooks[1].handler(createContext({logger, org: createMockOrg(), timing: 'post'})),
      ).rejects.toThrow("Script 'scripts/run.sh' failed");
    });

    it('should warn on script failure when failOnError is false', async () => {
      vi.mocked(ScriptRunner).mockImplementation(function() { return {
        run: vi.fn().mockResolvedValue({exitCode: 1, stderr: 'bad stuff', stdout: '', success: false}),
      }; } as any);

      const hooks = scriptHooks({
        failOnError: false,
        scripts: [{path: 'scripts/run.sh', timing: 'post'}],
      });
      const logger = createLogger();

      await hooks.hooks[1].handler(createContext({logger, org: createMockOrg(), timing: 'post'}));

      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringContaining("Script 'scripts/run.sh' failed"),
      );
    });
  });

  // --------------------------------------------------------------------------
  // Environment / context
  // --------------------------------------------------------------------------

  describe('execution context', () => {
    it('should pass custom env to runner', async () => {
      vi.mocked(ScriptRunner).mockImplementation(function() { return {
        run: vi.fn().mockResolvedValue({exitCode: 0, stderr: '', stdout: '', success: true}),
      }; } as any);

      const hooks = scriptHooks({
        scripts: [{env: {MY_VAR: 'hello'}, path: 'scripts/run.sh', timing: 'post'}],
      });
      const logger = createLogger();

      await hooks.hooks[1].handler(createContext({logger, org: createMockOrg(), timing: 'post'}));

      const instance = vi.mocked(ScriptRunner).mock.results[0].value;
      expect(instance.run).toHaveBeenCalledWith(
        expect.objectContaining({env: {MY_VAR: 'hello'}}),
        expect.any(String),
        expect.objectContaining({custom: {MY_VAR: 'hello'}}),
        expect.any(String),
      );
    });

    it('should resolve targetOrg from Org instance', async () => {
      vi.mocked(ScriptRunner).mockImplementation(function() { return {
        run: vi.fn().mockResolvedValue({exitCode: 0, stderr: '', stdout: '', success: true}),
      }; } as any);

      const hooks = scriptHooks({
        scripts: [{path: 'scripts/run.sh', timing: 'post'}],
      });
      const logger = createLogger();

      await hooks.hooks[1].handler(createContext({
        logger,
        org: createMockOrg('admin@myorg.com'),
        timing: 'post',
      }));

      const instance = vi.mocked(ScriptRunner).mock.results[0].value;
      expect(instance.run).toHaveBeenCalledWith(
        expect.any(Object),
        expect.any(String),
        expect.objectContaining({targetOrg: 'admin@myorg.com'}),
        expect.any(String),
      );
    });

    it('should pass undefined targetOrg when no Org instance', async () => {
      vi.mocked(ScriptRunner).mockImplementation(function() { return {
        run: vi.fn().mockResolvedValue({exitCode: 0, stderr: '', stdout: '', success: true}),
      }; } as any);

      const hooks = scriptHooks({
        scripts: [{path: 'scripts/run.sh', timing: 'post'}],
      });
      const logger = createLogger();

      await hooks.hooks[1].handler(createContext({logger, timing: 'post'}));

      const instance = vi.mocked(ScriptRunner).mock.results[0].value;
      expect(instance.run).toHaveBeenCalledWith(
        expect.any(Object),
        expect.any(String),
        expect.objectContaining({targetOrg: undefined}),
        expect.any(String),
      );
    });

    it('should normalise string overrides to ScriptDefinition', async () => {
      vi.mocked(resolveHookConfig).mockReturnValue({
        config: {post: ['scripts/from-pkg.sh']},
        enabled: true,
      });

      vi.mocked(ScriptRunner).mockImplementation(function() { return {
        run: vi.fn().mockResolvedValue({exitCode: 0, stderr: '', stdout: '', success: true}),
      }; } as any);

      const hooks = scriptHooks({scripts: []});
      const logger = createLogger();

      await hooks.hooks[1].handler(createContext({logger, org: createMockOrg(), timing: 'post'}));

      const instance = vi.mocked(ScriptRunner).mock.results[0].value;
      expect(instance.run).toHaveBeenCalledWith(
        expect.objectContaining({path: 'scripts/from-pkg.sh'}),
        'shell',
        expect.any(Object),
        expect.any(String),
      );
    });
  });
});
