import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import EventEmitter from 'node:events';

// Mock external dependencies
vi.mock('@actions/core', () => ({
  debug: vi.fn(),
  endGroup: vi.fn(),
  error: vi.fn(),
  getInput: vi.fn(),
  info: vi.fn(),
  notice: vi.fn(),
  setFailed: vi.fn(),
  setOutput: vi.fn(),
  startGroup: vi.fn(),
  warning: vi.fn(),
}));

vi.mock('@actions/github', () => ({
  context: {
    payload: {
      pull_request: {number: 42},
    },
  },
}));

vi.mock('@b64hub/sfpm-core', async importOriginal => {
  const actual = await importOriginal<typeof import('@b64hub/sfpm-core')>();
  return {
    ...actual,
    BuildOrchestrator: vi.fn(),
    GitService: {
      initialize: vi.fn(),
    },
    LifecycleEngine: {
      stage: vi.fn(),
    },
    ProjectService: {
      getInstance: vi.fn(),
    },
    ValidationEventBus: vi.fn(),
    ValidationResolver: vi.fn(),
  };
});
vi.mock('@b64hub/sfpm-orgs');
vi.mock('@b64hub/sfpm-telemetry');
vi.mock('@b64hub/sfpm-validation', () => ({
  NimbusLocalValidator: vi.fn(),
  NimbusValidationEventBus: vi.fn(),
}));
vi.mock('@salesforce/core', () => ({
  AuthInfo: {
    create: vi.fn(),
  },
  Org: {
    create: vi.fn(),
  },
  OrgTypes: {
    Sandbox: 'sandbox',
    Scratch: 'scratch',
  },
}));

import * as core from '@actions/core';
import {
  BuildOrchestrator,
  GitService,
  LifecycleEngine,
  ProjectService,
  ValidationResolver,
} from '@b64hub/sfpm-core';
import {createTracer} from '@b64hub/sfpm-telemetry';
import {AuthInfo, Org} from '@salesforce/core';

import {validatePr} from '../src/validate-pr.js';

// Mock OrgCacheService — must be after vi.mock calls
vi.mock('../src/org-cache.js', () => ({
  OrgCacheService: vi.fn(),
}));

import {OrgCacheService} from '../src/org-cache.js';

describe('validatePr', () => {
  let mockBuildOrchestrator: {buildAll: ReturnType<typeof vi.fn>; buildBus: EventEmitter; orchestrationBus: EventEmitter};
  let mockOrgCache: {restore: ReturnType<typeof vi.fn>; save: ReturnType<typeof vi.fn>; setOutputs: ReturnType<typeof vi.fn>};
  let mockValidationResolver: {resolve: ReturnType<typeof vi.fn>};

  const localOptions = {
    devhubUsername: 'devhub@test.com',
    projectDir: '/test/project',
  };

  const orgOptions = {
    ...localOptions,
    mode: 'org' as const,
    poolTag: 'ci-pool',
  };

  beforeEach(() => {
    vi.clearAllMocks();

    // Mock ProjectService
    vi.mocked(ProjectService.getInstance).mockResolvedValue({
      getDefinitionProvider: () => ({
        getAllPackageDefinitions: () => [
          {name: 'pkg-a', path: 'pkg-a'},
          {name: 'pkg-b', path: 'pkg-b'},
        ],
        getAllPackageNames: () => ['pkg-a', 'pkg-b'],
        getDependencies: () => [],
        projectDir: '/test/project',
      }),
      getProjectGraph: () => ({
        resolveDependencies: vi.fn(),
      }),
      getSfpmConfig: () => ({hooks: []}),
    } as any);

    // Mock BuildOrchestrator — real EventEmitters for buildBus/orchestrationBus event wiring
    mockBuildOrchestrator = {
      buildAll: vi.fn().mockResolvedValue({
        failedPackages: [],
        results: [
          {duration: 100, error: undefined, packageName: 'pkg-a', result: undefined, skipped: false, success: true},
          {duration: 200, error: undefined, packageName: 'pkg-b', result: undefined, skipped: false, success: true},
        ],
        skippedPackages: [],
        success: true,
      }),
      buildBus: new EventEmitter(),
      orchestrationBus: new EventEmitter(),
    };

    vi.mocked(BuildOrchestrator).mockImplementation(function () { return mockBuildOrchestrator; } as any);
    (BuildOrchestrator as any).create = vi.fn().mockReturnValue(mockBuildOrchestrator);

    // Mock LifecycleEngine
    vi.mocked(LifecycleEngine.stage).mockReturnValue({use: vi.fn()} as any);

    // Mock ValidationResolver (org mode's deploy-validation resolution)
    mockValidationResolver = {resolve: vi.fn().mockResolvedValue(new Map())};
    vi.mocked(ValidationResolver).mockImplementation(function () { return mockValidationResolver; } as any);

    // Mock OrgCacheService
    mockOrgCache = {
      restore: vi.fn().mockResolvedValue({
        cachedAt: Date.now(),
        cacheTtlMs: 14_400_000,
        orgId: '00D000000000000',
        prNumber: 42,
        sfdxAuthUrl: 'force://test',
        username: 'test@scratch.org',
      }),
      save: vi.fn().mockResolvedValue(undefined),
      setOutputs: vi.fn(),
    };
    vi.mocked(OrgCacheService).mockImplementation(function () { return mockOrgCache; } as any);

    // Mock AuthInfo and Org
    vi.mocked(AuthInfo.create).mockResolvedValue({save: vi.fn()} as any);
    vi.mocked(Org.create).mockResolvedValue({} as any);

    // Mock tracer
    vi.mocked(createTracer).mockReturnValue({
      shutdown: vi.fn().mockResolvedValue(undefined),
      subscribe: vi.fn(),
    } as any);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('changed-package detection (no explicit packages)', () => {
    it('validates only packages changed against baseRef', async () => {
      vi.mocked(GitService.initialize).mockResolvedValue({
        getChangedPackagePaths: vi.fn().mockResolvedValue(['pkg-a']),
      } as any);

      await validatePr({...localOptions, baseRef: 'main'});

      expect(mockBuildOrchestrator.buildAll).toHaveBeenCalledWith(['pkg-a']);
    });

    it('falls back to all packages when the git diff fails (e.g. shallow checkout)', async () => {
      vi.mocked(GitService.initialize).mockRejectedValue(new Error('unknown revision'));

      await validatePr({...localOptions, baseRef: 'main'});

      expect(mockBuildOrchestrator.buildAll).toHaveBeenCalledWith(['pkg-a', 'pkg-b']);
    });

    it('falls back to all packages when no baseRef is available', async () => {
      await validatePr(localOptions);

      expect(mockBuildOrchestrator.buildAll).toHaveBeenCalledWith(['pkg-a', 'pkg-b']);
    });

    it('explicit packages option bypasses changed-package detection', async () => {
      await validatePr({...localOptions, baseRef: 'main', packages: ['pkg-a']});

      expect(GitService.initialize).not.toHaveBeenCalled();
      expect(mockBuildOrchestrator.buildAll).toHaveBeenCalledWith(['pkg-a']);
    });
  });

  describe('local mode (default)', () => {
    it('does not touch the scratch org pool', async () => {
      await validatePr(localOptions);

      expect(OrgCacheService).not.toHaveBeenCalled();
    });

    it('runs BuildOrchestrator with no buildOrg and validation: local', async () => {
      await validatePr(localOptions);

      expect((BuildOrchestrator as any).create).toHaveBeenCalledWith(
        expect.anything(), // provider
        {},
        expect.anything(), // graph
        expect.objectContaining({
          continueOnError: true,
          includeDependencies: true,
          unlocked: undefined,
          validation: 'local',
        }),
        expect.anything(), // logger
        expect.anything(), // local nimbus validator
      );
    });

    it('returns a successful result with no org info', async () => {
      const result = await validatePr(localOptions);

      expect(result.success).toBe(true);
      expect(result.orgId).toBe('');
      expect(result.username).toBe('');
      expect(result.cacheHit).toBe(false);
    });

    it('fails when explicit mode is "org" without a poolTag', async () => {
      await expect(validatePr({...localOptions, mode: 'org'})).rejects.toThrow('poolTag is required');
    });
  });

  describe('org mode', () => {
    it('fetches/authenticates the scratch org and runs BuildOrchestrator with sourceOnly forced', async () => {
      await validatePr(orgOptions);

      expect((BuildOrchestrator as any).create).toHaveBeenCalledWith(
        expect.anything(), // provider
        expect.objectContaining({buildOrg: expect.anything()}),
        expect.anything(), // graph
        expect.objectContaining({
          continueOnError: true,
          includeDependencies: true,
          unlocked: {sourceOnly: true},
          validation: 'org',
        }),
        expect.anything(), // logger
        expect.anything(), // local nimbus validator
      );
    });

    it('calls buildAll with all package names', async () => {
      await validatePr(orgOptions);

      expect(mockBuildOrchestrator.buildAll).toHaveBeenCalledWith(['pkg-a', 'pkg-b']);
    });

    it('calls buildAll with specified packages when provided', async () => {
      await validatePr({...orgOptions, packages: ['pkg-a']});

      expect(mockBuildOrchestrator.buildAll).toHaveBeenCalledWith(['pkg-a']);
    });

    it('returns successful result with per-package outcomes and org info', async () => {
      const result = await validatePr(orgOptions);

      expect(result.success).toBe(true);
      expect(result.prNumber).toBe(42);
      expect(result.cacheHit).toBe(true);
      expect(result.username).toBe('test@scratch.org');
      expect(result.orgId).toBe('00D000000000000');
      expect(result.packages).toHaveLength(2);
      expect(result.packages[0]).toEqual(expect.objectContaining({
        packageName: 'pkg-a',
        success: true,
      }));
    });

    it('resolves pending deploy validations and fails when one is rejected', async () => {
      mockBuildOrchestrator.buildAll.mockResolvedValue({
        failedPackages: [],
        results: [
          {
            duration: 100, packageName: 'pkg-a', result: {pendingValidation: {operationType: 'deploy', packageName: 'pkg-a', targetOrg: 'test@scratch.org', testLevel: 'RunSpecifiedTests'}, skipped: false}, skipped: false, success: true,
          },
          {
            duration: 200, packageName: 'pkg-b', result: {pendingValidation: {operationType: 'deploy', packageName: 'pkg-b', targetOrg: 'test@scratch.org', testLevel: 'RunSpecifiedTests'}, skipped: false}, skipped: false, success: true,
          },
        ],
        skippedPackages: [],
        success: true,
      });
      mockValidationResolver.resolve.mockResolvedValue(new Map([
        ['pkg-a', {checks: ['deploy'], status: 'passed', testCoverage: 82.5}],
        ['pkg-b', {checks: ['deploy'], error: 'Apex test failed', status: 'failed'}],
      ]));

      const result = await validatePr(orgOptions);

      expect(mockValidationResolver.resolve).toHaveBeenCalled();
      expect(result.success).toBe(false);
      expect(result.packages[0]).toEqual(expect.objectContaining({coveragePercentage: 82.5, packageName: 'pkg-a', success: true}));
      expect(result.packages[1]).toEqual(expect.objectContaining({error: 'Apex test failed', packageName: 'pkg-b', success: false}));
      expect(core.setFailed).toHaveBeenCalledWith('Validation failed for: pkg-b');
    });

    it('skips ValidationResolver entirely when there are no pending validations', async () => {
      await validatePr(orgOptions);

      expect(mockValidationResolver.resolve).not.toHaveBeenCalled();
    });

    it('calls setFailed when the build itself fails', async () => {
      mockBuildOrchestrator.buildAll.mockResolvedValue({
        failedPackages: ['pkg-b'],
        results: [
          {duration: 100, packageName: 'pkg-a', skipped: false, success: true},
          {
            duration: 200, error: 'Deploy failed', packageName: 'pkg-b', skipped: false, success: false,
          },
        ],
        skippedPackages: [],
        success: false,
      });

      const result = await validatePr(orgOptions);

      expect(result.success).toBe(false);
      expect(core.setFailed).toHaveBeenCalledWith('Validation failed for: pkg-b');
    });

    it('sets action outputs', async () => {
      await validatePr(orgOptions);

      expect(core.setOutput).toHaveBeenCalledWith('success', 'true');
      expect(core.setOutput).toHaveBeenCalledWith('org-username', 'test@scratch.org');
      expect(core.setOutput).toHaveBeenCalledWith('org-id', '00D000000000000');
      expect(core.setOutput).toHaveBeenCalledWith('pr-number', '42');
      expect(core.setOutput).toHaveBeenCalledWith('result', expect.any(String));
    });

    it('includes includeDependencies: true in orchestrator options', async () => {
      await validatePr(orgOptions);

      expect((BuildOrchestrator as any).create).toHaveBeenCalledWith(
        expect.anything(), // provider
        expect.anything(), // buildOrg opts
        expect.anything(), // graph
        expect.objectContaining({
          includeDependencies: true,
        }),
        expect.anything(), // logger
        expect.anything(), // local nimbus validator
      );
    });
  });
});
