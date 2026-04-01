import {
  beforeEach, describe, expect, it, vi,
} from 'vitest';

import type {HookContext} from '@b64/sfpm-core';
import {PackageType} from '@b64/sfpm-core';
import {Org} from '@salesforce/core';

import {standardValueSetHooks} from '../../src/standard-value-set/standard-value-set-plugin.js';

// ============================================================================
// Mocks
// ============================================================================

vi.mock('node:fs', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:fs')>();
  return {
    ...original,
    existsSync: vi.fn().mockReturnValue(false),
  };
});

vi.mock('../../src/standard-value-set/standard-value-set-deployer.js', () => ({
  StandardValueSetDeployer: vi.fn().mockImplementation(function() { return {
    deploy: vi.fn().mockResolvedValue({componentsDeployed: 1, componentsTotal: 1, success: true}),
  }; }),
}));

import {existsSync} from 'node:fs';
import {StandardValueSetDeployer} from '../../src/standard-value-set/standard-value-set-deployer.js';

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
    packageType: 'Unlocked',
    timing: 'post',
    ...overrides,
  };
}

// ============================================================================
// Tests
// ============================================================================

describe('standardValueSetHooks', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });
  // --------------------------------------------------------------------------
  // Structure
  // --------------------------------------------------------------------------

  it('should return valid LifecycleHooks', () => {
    const hooks = standardValueSetHooks();

    expect(hooks.name).toBe('standard-value-set');
    expect(hooks.hooks).toHaveLength(1);
    expect(hooks.hooks[0].operation).toBe('install');
    expect(hooks.hooks[0].timing).toBe('post');
  });

  // --------------------------------------------------------------------------
  // Guard: package type
  // --------------------------------------------------------------------------

  it('should skip non-unlocked packages', async () => {
    const hooks = standardValueSetHooks();
    const logger = createLogger();

    await hooks.hooks[0].handler(createContext({
      logger,
      org: createMockOrg(),
      sfpmPackage: {standardValueSets: [], type: PackageType.Source},
    }));

    expect(logger.debug).toHaveBeenCalledWith(
      expect.stringContaining('not an unlocked package'),
    );
  });

  // --------------------------------------------------------------------------
  // Guard: no org
  // --------------------------------------------------------------------------

  it('should skip when no org connection', async () => {
    const hooks = standardValueSetHooks();
    const logger = createLogger();

    await hooks.hooks[0].handler(createContext({
      logger,
      sfpmPackage: {standardValueSets: [{fullName: 'Industry'}], type: PackageType.Unlocked},
    }));

    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('no org connection'),
    );
  });

  // --------------------------------------------------------------------------
  // Guard: no SVS components
  // --------------------------------------------------------------------------

  it('should skip when no standard value sets in package', async () => {
    const hooks = standardValueSetHooks();
    const logger = createLogger();

    await hooks.hooks[0].handler(createContext({
      logger,
      org: createMockOrg(),
      sfpmPackage: {standardValueSets: [], type: PackageType.Unlocked},
    }));

    expect(logger.debug).toHaveBeenCalledWith(
      expect.stringContaining('no standard value sets'),
    );
  });

  // --------------------------------------------------------------------------
  // Guard: no SVS directory
  // --------------------------------------------------------------------------

  it('should warn when SVS directory not found', async () => {
    vi.mocked(existsSync).mockReturnValue(false);

    const hooks = standardValueSetHooks();
    const logger = createLogger();

    await hooks.hooks[0].handler(createContext({
      logger,
      org: createMockOrg(),
      sfpmPackage: {
        packageDirectory: '/some/path',
        standardValueSets: [{fullName: 'Industry'}],
        type: PackageType.Unlocked,
      },
    }));

    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('no standardValueSets directory'),
    );
  });

  it('should warn when packageDirectory is undefined', async () => {
    const hooks = standardValueSetHooks();
    const logger = createLogger();

    await hooks.hooks[0].handler(createContext({
      logger,
      org: createMockOrg(),
      sfpmPackage: {
        standardValueSets: [{fullName: 'Industry'}],
        type: PackageType.Unlocked,
      },
    }));

    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('no standardValueSets directory'),
    );
  });

  // --------------------------------------------------------------------------
  // Deploy
  // --------------------------------------------------------------------------

  it('should deploy SVS when directory exists', async () => {
    vi.mocked(existsSync).mockImplementation((p: any) =>
      String(p).includes('standardValueSets'));

    vi.mocked(StandardValueSetDeployer).mockImplementation(function() { return {
      deploy: vi.fn().mockResolvedValue({componentsDeployed: 2, componentsTotal: 2, success: true}),
    }; } as any);

    const hooks = standardValueSetHooks();
    const logger = createLogger();
    const org = createMockOrg();

    await hooks.hooks[0].handler(createContext({
      logger,
      org,
      sfpmPackage: {
        packageDirectory: '/pkg/dir',
        standardValueSets: [{fullName: 'Industry'}, {fullName: 'CaseOrigin'}],
        type: PackageType.Unlocked,
      },
    }));

    expect(StandardValueSetDeployer).toHaveBeenCalledWith(
      org.getConnection(),
      logger,
    );

    const deployerInstance = vi.mocked(StandardValueSetDeployer).mock.results[0].value;
    expect(deployerInstance.deploy).toHaveBeenCalledWith(
      expect.stringContaining('standardValueSets'),
      undefined,
    );

    expect(logger.info).toHaveBeenCalledWith(
      expect.stringContaining('deploying 2 standard value set(s)'),
    );
  });

  it('should pass valueSetNames option to deployer', async () => {
    vi.mocked(existsSync).mockImplementation((p: any) =>
      String(p).includes('standardValueSets'));

    vi.mocked(StandardValueSetDeployer).mockImplementation(function() { return {
      deploy: vi.fn().mockResolvedValue({componentsDeployed: 1, componentsTotal: 1, success: true}),
    }; } as any);

    const hooks = standardValueSetHooks({valueSetNames: ['Industry']});
    const logger = createLogger();

    await hooks.hooks[0].handler(createContext({
      logger,
      org: createMockOrg(),
      sfpmPackage: {
        packageDirectory: '/pkg/dir',
        standardValueSets: [{fullName: 'Industry'}, {fullName: 'CaseOrigin'}],
        type: PackageType.Unlocked,
      },
    }));

    const deployerInstance = vi.mocked(StandardValueSetDeployer).mock.results[0].value;
    expect(deployerInstance.deploy).toHaveBeenCalledWith(
      expect.any(String),
      ['Industry'],
    );
  });

  it('should throw when deployment fails', async () => {
    vi.mocked(existsSync).mockImplementation((p: any) =>
      String(p).includes('standardValueSets'));

    vi.mocked(StandardValueSetDeployer).mockImplementation(function() { return {
      deploy: vi.fn().mockResolvedValue({componentsDeployed: 0, componentsTotal: 2, success: false}),
    }; } as any);

    const hooks = standardValueSetHooks();
    const logger = createLogger();

    await expect(
      hooks.hooks[0].handler(createContext({
        logger,
        org: createMockOrg(),
        sfpmPackage: {
          packageDirectory: '/pkg/dir',
          standardValueSets: [{fullName: 'Industry'}],
          type: PackageType.Unlocked,
        },
      })),
    ).rejects.toThrow('deployment failed');
  });
});
