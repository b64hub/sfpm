import {
  beforeEach, describe, expect, it, vi,
} from 'vitest';

import type {HookContext} from '@b64/sfpm-core';
import {resolveHookConfig} from '@b64/sfpm-core';
import {Org} from '@salesforce/core';

import {permissionSetHooks} from '../../src/permissionset/permset-plugin.js';

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

vi.mock('../../src/permissionset/permset-assigner.js', () => ({
  PermissionSetAssigner: vi.fn().mockImplementation(function() { return {
    assign: vi.fn().mockResolvedValue({assigned: [], failed: [], skipped: []}),
  }; }),
}));

import {PermissionSetAssigner} from '../../src/permissionset/permset-assigner.js';

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

function createMockOrg() {
  const connection = {query: vi.fn()};
  const org = Object.create(Org.prototype);
  org.getConnection = vi.fn().mockReturnValue(connection);
  return org as Org;
}

function createContext(overrides?: Partial<HookContext>): HookContext {
  return {
    operation: 'install',
    packageName: 'test-package',
    timing: 'pre',
    ...overrides,
  };
}

// ============================================================================
// Tests
// ============================================================================

describe('permissionSetHooks', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(resolveHookConfig).mockReturnValue({config: {}, enabled: true});
  });

  // --------------------------------------------------------------------------
  // Structure
  // --------------------------------------------------------------------------

  it('should return valid LifecycleHooks', () => {
    const hooks = permissionSetHooks();

    expect(hooks.name).toBe('permission-set');
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
    it('should skip when no pre perm sets resolved', async () => {
      vi.mocked(resolveHookConfig).mockReturnValue({config: {}, enabled: true});
      const hooks = permissionSetHooks();
      const logger = createLogger();

      await hooks.hooks[0].handler(createContext({logger, org: createMockOrg()}));

      expect(logger.debug).toHaveBeenCalledWith(
        expect.stringContaining('no permission sets to assign'),
      );
      expect(PermissionSetAssigner).not.toHaveBeenCalled();
    });

    it('should skip when no org connection', async () => {
      vi.mocked(resolveHookConfig).mockReturnValue({
        config: {pre: ['ReadOnly']},
        enabled: true,
      });
      const hooks = permissionSetHooks();
      const logger = createLogger();

      await hooks.hooks[0].handler(createContext({logger}));

      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringContaining('no org connection'),
      );
    });

    it('should assign per-package pre perm sets', async () => {
      vi.mocked(resolveHookConfig).mockReturnValue({
        config: {pre: ['ReadOnlyUser']},
        enabled: true,
      });

      vi.mocked(PermissionSetAssigner).mockImplementation(function() { return {
        assign: vi.fn().mockResolvedValue({
          assigned: ['ReadOnlyUser'],
          failed: [],
          skipped: [],
        }),
      }; } as any);

      const hooks = permissionSetHooks();
      const logger = createLogger();
      const org = createMockOrg();

      await hooks.hooks[0].handler(createContext({logger, org}));

      expect(PermissionSetAssigner).toHaveBeenCalledWith(
        org.getConnection(),
        logger,
      );

      const instance = vi.mocked(PermissionSetAssigner).mock.results[0].value;
      expect(instance.assign).toHaveBeenCalledWith(['ReadOnlyUser']);
    });
  });

  // --------------------------------------------------------------------------
  // Post hook
  // --------------------------------------------------------------------------

  describe('install:post handler', () => {
    it('should merge global and per-package post perm sets', async () => {
      vi.mocked(resolveHookConfig).mockReturnValue({
        config: {post: ['PackageSpecific']},
        enabled: true,
      });

      vi.mocked(PermissionSetAssigner).mockImplementation(function() { return {
        assign: vi.fn().mockResolvedValue({
          assigned: ['SharedPermSet', 'PackageSpecific'],
          failed: [],
          skipped: [],
        }),
      }; } as any);

      const hooks = permissionSetHooks({permSets: ['SharedPermSet']});
      const logger = createLogger();
      const org = createMockOrg();

      await hooks.hooks[1].handler(createContext({logger, org, timing: 'post'}));

      const instance = vi.mocked(PermissionSetAssigner).mock.results[0].value;
      expect(instance.assign).toHaveBeenCalledWith(
        expect.arrayContaining(['PackageSpecific', 'SharedPermSet']),
      );
    });

    it('should skip when no post perm sets resolved', async () => {
      vi.mocked(resolveHookConfig).mockReturnValue({config: {}, enabled: true});
      const hooks = permissionSetHooks();
      const logger = createLogger();

      await hooks.hooks[1].handler(createContext({logger, org: createMockOrg(), timing: 'post'}));

      expect(logger.debug).toHaveBeenCalledWith(
        expect.stringContaining('no permission sets to assign'),
      );
    });

    it('should deduplicate perm sets', async () => {
      vi.mocked(resolveHookConfig).mockReturnValue({
        config: {post: ['SharedPermSet']},
        enabled: true,
      });

      vi.mocked(PermissionSetAssigner).mockImplementation(function() { return {
        assign: vi.fn().mockResolvedValue({
          assigned: ['SharedPermSet'],
          failed: [],
          skipped: [],
        }),
      }; } as any);

      const hooks = permissionSetHooks({permSets: ['SharedPermSet']});
      const logger = createLogger();

      await hooks.hooks[1].handler(createContext({logger, org: createMockOrg(), timing: 'post'}));

      const instance = vi.mocked(PermissionSetAssigner).mock.results[0].value;
      // Should be deduplicated — only one entry
      expect(instance.assign).toHaveBeenCalledWith(['SharedPermSet']);
    });
  });

  // --------------------------------------------------------------------------
  // Result handling
  // --------------------------------------------------------------------------

  describe('handleResult', () => {
    it('should log assigned perm sets', async () => {
      vi.mocked(resolveHookConfig).mockReturnValue({
        config: {post: ['AdminPerm']},
        enabled: true,
      });

      vi.mocked(PermissionSetAssigner).mockImplementation(function() { return {
        assign: vi.fn().mockResolvedValue({
          assigned: ['AdminPerm'],
          failed: [],
          skipped: [],
        }),
      }; } as any);

      const hooks = permissionSetHooks();
      const logger = createLogger();

      await hooks.hooks[1].handler(createContext({logger, org: createMockOrg(), timing: 'post'}));

      expect(logger.info).toHaveBeenCalledWith(
        expect.stringContaining('assigned AdminPerm'),
      );
    });

    it('should log skipped perm sets at debug level', async () => {
      vi.mocked(resolveHookConfig).mockReturnValue({
        config: {post: ['AlreadyAssigned']},
        enabled: true,
      });

      vi.mocked(PermissionSetAssigner).mockImplementation(function() { return {
        assign: vi.fn().mockResolvedValue({
          assigned: [],
          failed: [],
          skipped: ['AlreadyAssigned'],
        }),
      }; } as any);

      const hooks = permissionSetHooks();
      const logger = createLogger();

      await hooks.hooks[1].handler(createContext({logger, org: createMockOrg(), timing: 'post'}));

      expect(logger.debug).toHaveBeenCalledWith(
        expect.stringContaining('already assigned AlreadyAssigned'),
      );
    });

    it('should warn on failure when failOnError is false (default)', async () => {
      vi.mocked(resolveHookConfig).mockReturnValue({
        config: {post: ['BadPerm']},
        enabled: true,
      });

      vi.mocked(PermissionSetAssigner).mockImplementation(function() { return {
        assign: vi.fn().mockResolvedValue({
          assigned: [],
          failed: [{message: 'Not found', name: 'BadPerm'}],
          skipped: [],
        }),
      }; } as any);

      const hooks = permissionSetHooks();
      const logger = createLogger();

      await hooks.hooks[1].handler(createContext({logger, org: createMockOrg(), timing: 'post'}));

      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringContaining('failed assignments'),
      );
    });

    it('should throw on failure when failOnError is true', async () => {
      vi.mocked(resolveHookConfig).mockReturnValue({
        config: {post: ['BadPerm']},
        enabled: true,
      });

      vi.mocked(PermissionSetAssigner).mockImplementation(function() { return {
        assign: vi.fn().mockResolvedValue({
          assigned: [],
          failed: [{message: 'Not found', name: 'BadPerm'}],
          skipped: [],
        }),
      }; } as any);

      const hooks = permissionSetHooks({failOnError: true});
      const logger = createLogger();

      await expect(
        hooks.hooks[1].handler(createContext({logger, org: createMockOrg(), timing: 'post'})),
      ).rejects.toThrow('failed assignments');
    });
  });
});
