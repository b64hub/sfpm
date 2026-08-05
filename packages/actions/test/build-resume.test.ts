import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

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
  context: {runId: 123},
}));

vi.mock('@b64hub/sfpm-core', () => ({
  ValidationPoller: vi.fn(),
}));

vi.mock('@salesforce/core', () => ({
  Org: {
    create: vi.fn(),
  },
}));

import * as core from '@actions/core';
import {ValidationPoller} from '@b64hub/sfpm-core';
import {Org} from '@salesforce/core';

import type {CachedBuildState} from '../src/build-cache.js';

import {buildResume} from '../src/build-resume.js';

// Mock BuildCacheService — must be after vi.mock calls
vi.mock('../src/build-cache.js', () => ({
  BuildCacheService: vi.fn(),
}));

import {BuildCacheService} from '../src/build-cache.js';

function stateWith(packages: CachedBuildState['packages']): CachedBuildState {
  return {
    cachedAt: Date.now(),
    devhubUsername: 'devhub@test.com',
    packages,
    projectDir: '/test/project',
    runId: '123',
  };
}

describe('buildResume', () => {
  let mockRestore: ReturnType<typeof vi.fn>;
  let mockPollAll: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();

    mockRestore = vi.fn();
    vi.mocked(BuildCacheService).mockImplementation(function () {
      return {restore: mockRestore} as any;
    } as any);

    mockPollAll = vi.fn().mockResolvedValue([]);
    vi.mocked(ValidationPoller).mockImplementation(function () {
      return {pollAll: mockPollAll} as any;
    } as any);

    vi.mocked(Org.create).mockResolvedValue({getConnection: () => ({})} as any);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('publishes packages that needed validation and passed', async () => {
    mockRestore.mockResolvedValue(stateWith([
      {
        needsValidation: true, packageName: 'unlocked-pkg', packageType: 'Unlocked', packageVersionCreateRequestId: 'req1', skipped: false, success: true,
      },
    ]));
    mockPollAll.mockResolvedValue([
      {packageName: 'unlocked-pkg', status: 'Success'},
    ]);

    const result = await buildResume({});

    expect(result.publishablePackages).toEqual(['unlocked-pkg']);
    expect(result.success).toBe(true);
  });

  it('excludes packages that needed validation and failed', async () => {
    mockRestore.mockResolvedValue(stateWith([
      {
        needsValidation: true, packageName: 'unlocked-pkg', packageType: 'Unlocked', packageVersionCreateRequestId: 'req1', skipped: false, success: true,
      },
    ]));
    mockPollAll.mockResolvedValue([
      {packageName: 'unlocked-pkg', status: 'Error'},
    ]);

    const result = await buildResume({});

    expect(result.publishablePackages).toEqual([]);
    expect(result.success).toBe(false);
  });

  it('publishes successfully built packages that never needed validation', async () => {
    mockRestore.mockResolvedValue(stateWith([
      {
        needsValidation: false, packageName: 'source-pkg', packageType: 'Source', skipped: false, success: true,
      },
    ]));

    const result = await buildResume({});

    expect(result.publishablePackages).toEqual(['source-pkg']);
    expect(result.success).toBe(true);
  });

  it('excludes packages that failed to build, even though they never needed validation', async () => {
    mockRestore.mockResolvedValue(stateWith([
      {
        needsValidation: false, packageName: 'broken-pkg', packageType: 'Source', skipped: false, success: false,
      },
    ]));

    const result = await buildResume({});

    expect(result.publishablePackages).toEqual([]);
  });

  it('excludes packages whose build was skipped (no source changes)', async () => {
    mockRestore.mockResolvedValue(stateWith([
      {
        needsValidation: false, packageName: 'unchanged-pkg', packageType: 'Source', skipped: true, success: true,
      },
    ]));

    const result = await buildResume({});

    expect(result.publishablePackages).toEqual([]);
  });

  it('sets the publishable-packages output', async () => {
    mockRestore.mockResolvedValue(stateWith([
      {
        needsValidation: false, packageName: 'pkg-a', packageType: 'Source', skipped: false, success: true,
      },
      {
        needsValidation: false, packageName: 'pkg-b', packageType: 'Source', skipped: true, success: true,
      },
    ]));

    await buildResume({});

    expect(core.setOutput).toHaveBeenCalledWith('publishable-packages', 'pkg-a');
  });

  it('returns an empty publishable list when no build state is found', async () => {
    mockRestore.mockResolvedValue(undefined);

    const result = await buildResume({});

    expect(result.publishablePackages).toEqual([]);
    expect(result.success).toBe(false);
  });
});
