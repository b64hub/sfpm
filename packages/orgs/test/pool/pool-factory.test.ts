import {beforeEach, describe, expect, it, vi} from 'vitest';

// Use class-based mocks so `new Constructor(...)` works
vi.mock('@salesforce/core', () => ({
  Org: class MockOrg {},
  OrgTypes: {Sandbox: 'sandbox', Scratch: 'scratch'},
}));
vi.mock('../../src/org/sandbox/sandbox-provider.js', () => ({
  default: vi.fn(function (this: Record<string, unknown>) { this._type = 'sandbox'; }),
}));
vi.mock('../../src/org/scratch/scratch-org-provider.js', () => ({
  default: vi.fn(function (this: Record<string, unknown>) { this._type = 'scratch'; }),
}));
vi.mock('../../src/org/services/auth-service.js', () => ({
  default: vi.fn(function () { /* noop */ }),
}));
vi.mock('../../src/org/services/devhub-service.js', () => ({
  default: vi.fn(function (this: Record<string, unknown>) {
    this.getJwtConfig = vi.fn().mockReturnValue({clientId: 'test-client-id', keyFile: '/path/to/key'});
  }),
}));
vi.mock('../../src/pool/pool-fetcher.js', () => ({
  default: vi.fn(function () { /* noop */ }),
}));
vi.mock('../../src/pool/pool-manager.js', () => ({
  default: vi.fn(function () { /* noop */ }),
}));

import type {Org} from '@salesforce/core';
import {OrgTypes} from '@salesforce/core';

import SandboxProvider from '../../src/org/sandbox/sandbox-provider.js';
import ScratchOrgProvider from '../../src/org/scratch/scratch-org-provider.js';
import AuthService from '../../src/org/services/auth-service.js';
import DevHubService from '../../src/org/services/devhub-service.js';
import PoolFetcher from '../../src/pool/pool-fetcher.js';
import {createPoolServices} from '../../src/pool/pool-factory.js';
import PoolManager from '../../src/pool/pool-manager.js';

function createMockOrg(overrides: Partial<Record<string, unknown>> = {}): Org {
  return {
    getUsername: vi.fn().mockReturnValue('devhub@test.com'),
    isDevHubOrg: vi.fn().mockReturnValue(true),
    getConnection: vi.fn(),
    ...overrides,
  } as unknown as Org;
}

describe('createPoolServices', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    // Reset DevHubService to return JWT config with clientId
    vi.mocked(DevHubService).mockImplementation(function (this: Record<string, unknown>) {
      this.getJwtConfig = vi.fn().mockReturnValue({clientId: 'test-client-id', keyFile: '/path/to/key'});
    } as never);
  });

  it('should create services with scratch org provider by default', () => {
    const devhub = createMockOrg();
    const result = createPoolServices({devhub});

    expect(ScratchOrgProvider).toHaveBeenCalledWith(devhub);
    expect(SandboxProvider).not.toHaveBeenCalled();
    expect(result).toHaveProperty('authenticator');
    expect(result).toHaveProperty('devhubService');
    expect(result).toHaveProperty('fetcher');
    expect(result).toHaveProperty('manager');
  });

  it('should create services with sandbox provider when poolType is sandbox', () => {
    const devhub = createMockOrg();
    createPoolServices({devhub, poolType: OrgTypes.Sandbox});

    expect(SandboxProvider).toHaveBeenCalledWith(devhub);
    expect(ScratchOrgProvider).not.toHaveBeenCalled();
  });

  it('should create services with scratch org provider when poolType is scratch', () => {
    const devhub = createMockOrg();
    createPoolServices({devhub, poolType: OrgTypes.Scratch});

    expect(ScratchOrgProvider).toHaveBeenCalledWith(devhub);
  });

  it('should pass logger to DevHubService and PoolManager', () => {
    const devhub = createMockOrg();
    const logger = {debug: vi.fn(), error: vi.fn(), info: vi.fn(), trace: vi.fn(), warn: vi.fn()};

    createPoolServices({devhub, logger});

    expect(DevHubService).toHaveBeenCalledWith(devhub, logger);
    expect(PoolManager).toHaveBeenCalledWith(
      expect.objectContaining({logger}),
    );
  });

  it('should pass tasks to PoolManager', () => {
    const devhub = createMockOrg();
    const tasks = [{name: 'prepare', run: vi.fn()}];

    createPoolServices({devhub, tasks: tasks as never});

    expect(PoolManager).toHaveBeenCalledWith(
      expect.objectContaining({tasks}),
    );
  });

  it('should pass provider to PoolFetcher', () => {
    const devhub = createMockOrg();
    createPoolServices({devhub});

    // PoolFetcher receives the provider instance
    expect(PoolFetcher).toHaveBeenCalledWith(
      expect.anything(), // the provider instance
      undefined, // no logger
    );
  });

  it('should create AuthService with devhub username and JWT config', () => {
    const devhub = createMockOrg();
    createPoolServices({devhub});

    expect(AuthService).toHaveBeenCalledWith(
      'devhub@test.com',
      {clientId: 'test-client-id', keyFile: '/path/to/key'},
    );
  });

  it('should pass undefined JWT config when clientId is missing', () => {
    vi.mocked(DevHubService).mockImplementation(function (this: Record<string, unknown>) {
      this.getJwtConfig = vi.fn().mockReturnValue({});
    } as never);

    const devhub = createMockOrg();
    createPoolServices({devhub});

    expect(AuthService).toHaveBeenCalledWith('devhub@test.com', undefined);
  });

  it('should throw when hub org has no username', () => {
    const devhub = createMockOrg({getUsername: vi.fn().mockReturnValue(undefined)});

    expect(() => createPoolServices({devhub})).toThrow(
      'Hub org must be authenticated and have a username',
    );
  });

  it('should throw when hub org is not a DevHub', () => {
    const devhub = createMockOrg({isDevHubOrg: vi.fn().mockReturnValue(false)});

    expect(() => createPoolServices({devhub})).toThrow(
      'Hub org must be a DevHub',
    );
  });
});
