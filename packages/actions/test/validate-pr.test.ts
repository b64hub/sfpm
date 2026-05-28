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

vi.mock('@b64hub/sfpm-core', () => ({
  BuildOrchestrator: vi.fn(),
  LifecycleEngine: {
    stage: vi.fn(),
  },
  ProjectService: {
    getInstance: vi.fn(),
  },
}));
vi.mock('@b64hub/sfpm-orgs');
vi.mock('@b64hub/sfpm-telemetry');
vi.mock('@salesforce/core', () => ({
  AuthInfo: {
    create: vi.fn(),
  },
  Org: {
    create: vi.fn(),
  },
}));

import * as core from '@actions/core';
import {
  BuildOrchestrator,
  LifecycleEngine,
  ProjectService,
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
  let mockBuildOrchestrator: EventEmitter & {buildAll: ReturnType<typeof vi.fn>};
  let mockOrgCache: {restore: ReturnType<typeof vi.fn>; save: ReturnType<typeof vi.fn>; setOutputs: ReturnType<typeof vi.fn>};

  const defaultOptions = {
    devhubUsername: 'devhub@test.com',
    poolTag: 'ci-pool',
    projectDir: '/test/project',
  };

  beforeEach(() => {
    vi.clearAllMocks();

    // Mock ProjectService
    vi.mocked(ProjectService.getInstance).mockResolvedValue({
      getDefinitionProvider: () => ({
        getAllPackageNames: () => ['pkg-a', 'pkg-b'],
      }),
      getProjectGraph: () => ({
        resolveDependencies: vi.fn(),
      }),
      getSfpmConfig: () => ({hooks: []}),
    } as any);

    // Mock BuildOrchestrator — use a real EventEmitter for event wiring
    mockBuildOrchestrator = Object.assign(new EventEmitter(), {
      buildAll: vi.fn().mockResolvedValue({
        failedPackages: [],
        results: [
          {duration: 100, error: undefined, packageName: 'pkg-a', skipped: false, success: true},
          {duration: 200, error: undefined, packageName: 'pkg-b', skipped: false, success: true},
        ],
        skippedPackages: [],
        success: true,
      }),
    });

    vi.mocked(BuildOrchestrator).mockImplementation(function () { return mockBuildOrchestrator; } as any);

    // Mock LifecycleEngine
    vi.mocked(LifecycleEngine.stage).mockReturnValue({use: vi.fn()} as any);

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

  it('should use BuildOrchestrator with validate mode', async () => {
    await validatePr(defaultOptions);

    expect(BuildOrchestrator).toHaveBeenCalledWith(
      expect.anything(), // provider
      expect.anything(), // graph
      expect.objectContaining({
        buildOrg: 'test@scratch.org',
        continueOnError: true,
        devhubUsername: 'devhub@test.com',
        mode: 'validate',
      }),
      expect.anything(), // logger
      '/test/project',
    );
  });

  it('should call buildAll with all package names', async () => {
    await validatePr(defaultOptions);

    expect(mockBuildOrchestrator.buildAll).toHaveBeenCalledWith(['pkg-a', 'pkg-b']);
  });

  it('should call buildAll with specified packages when provided', async () => {
    await validatePr({...defaultOptions, packages: ['pkg-a']});

    expect(mockBuildOrchestrator.buildAll).toHaveBeenCalledWith(['pkg-a']);
  });

  it('should return successful result with per-package outcomes', async () => {
    const result = await validatePr(defaultOptions);

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

  it('should capture coverage data from task:validation:complete events', async () => {
    // Override buildAll to emit coverage events during execution
    mockBuildOrchestrator.buildAll.mockImplementation(async () => {
      mockBuildOrchestrator.emit('task:validation:complete', {
        coveragePercentage: 82.5,
        packageName: 'pkg-a',
      });
      mockBuildOrchestrator.emit('task:validation:complete', {
        coveragePercentage: 91.0,
        packageName: 'pkg-b',
      });

      return {
        failedPackages: [],
        results: [
          {duration: 100, packageName: 'pkg-a', skipped: false, success: true},
          {duration: 200, packageName: 'pkg-b', skipped: false, success: true},
        ],
        skippedPackages: [],
        success: true,
      };
    });

    const result = await validatePr(defaultOptions);

    expect(result.packages[0].coveragePercentage).toBe(82.5);
    expect(result.packages[1].coveragePercentage).toBe(91.0);
  });

  it('should call setFailed when validation fails', async () => {
    mockBuildOrchestrator.buildAll.mockResolvedValue({
      failedPackages: ['pkg-b'],
      results: [
        {duration: 100, packageName: 'pkg-a', skipped: false, success: true},
        {duration: 200, error: 'Coverage below 75%', packageName: 'pkg-b', skipped: false, success: false},
      ],
      skippedPackages: [],
      success: false,
    });

    const result = await validatePr(defaultOptions);

    expect(result.success).toBe(false);
    expect(core.setFailed).toHaveBeenCalledWith('Validation failed for: pkg-b');
  });

  it('should set action outputs', async () => {
    await validatePr(defaultOptions);

    expect(core.setOutput).toHaveBeenCalledWith('success', 'true');
    expect(core.setOutput).toHaveBeenCalledWith('org-username', 'test@scratch.org');
    expect(core.setOutput).toHaveBeenCalledWith('org-id', '00D000000000000');
    expect(core.setOutput).toHaveBeenCalledWith('pr-number', '42');
    expect(core.setOutput).toHaveBeenCalledWith('result', expect.any(String));
  });

  it('should include includeDependencies: true in orchestrator options', async () => {
    await validatePr(defaultOptions);

    expect(BuildOrchestrator).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({
        includeDependencies: true,
      }),
      expect.anything(),
      expect.anything(),
    );
  });
});
