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

const mockResolve = vi.fn();

vi.mock('@b64hub/sfpm-core', () => ({
  ProjectService: {
    getInstance: vi.fn().mockResolvedValue({
      getDefinitionProvider: vi.fn().mockReturnValue({}),
      getProjectGraph: vi.fn().mockReturnValue({}),
    }),
  },
  ValidationEventBus: vi.fn(),
  ValidationResolver: vi.fn().mockImplementation(function () {
    return {resolve: mockResolve};
  }),
}));

import * as core from '@actions/core';

import type {BuildResult} from '../src/build.js';

import {buildValidation} from '../src/build-validation.js';

function stateWith(packages: BuildResult['packages']): string {
  return JSON.stringify({
    duration: 0, failedPackages: [], packages, success: true,
  } satisfies BuildResult);
}

describe('buildValidation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockResolve.mockResolvedValue(new Map());
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('publishes packages that needed validation and passed', async () => {
    mockResolve.mockResolvedValue(new Map([
      ['unlocked-pkg', {checks: ['dependencies', 'deploy', 'test'], status: 'passed'}],
    ]));

    const result = await buildValidation({
      buildResult: stateWith([
        {
          packageName: 'unlocked-pkg',
          packageType: 'Unlocked',
          pendingValidation: {
            devhub: 'devhub@test.com', operationType: 'package-version-request', packageName: 'unlocked-pkg', packageVersionRequestId: 'req1',
          },
          skipped: false,
          success: true,
        },
      ]),
    });

    expect(result.publishablePackages).toEqual(['unlocked-pkg']);
    expect(result.success).toBe(true);
  });

  it('excludes packages that needed validation and failed', async () => {
    mockResolve.mockResolvedValue(new Map([
      ['unlocked-pkg', {checks: ['dependencies', 'deploy', 'test'], error: 'boom', status: 'failed'}],
    ]));

    const result = await buildValidation({
      buildResult: stateWith([
        {
          packageName: 'unlocked-pkg',
          packageType: 'Unlocked',
          pendingValidation: {
            devhub: 'devhub@test.com', operationType: 'package-version-request', packageName: 'unlocked-pkg', packageVersionRequestId: 'req1',
          },
          skipped: false,
          success: true,
        },
      ]),
    });

    expect(result.publishablePackages).toEqual([]);
    expect(result.success).toBe(false);
  });

  it('publishes successfully built packages that never needed validation', async () => {
    const result = await buildValidation({
      buildResult: stateWith([
        {
          packageName: 'source-pkg', packageType: 'Source', skipped: false, success: true,
        },
      ]),
    });

    expect(result.publishablePackages).toEqual(['source-pkg']);
    expect(result.success).toBe(true);
    expect(mockResolve).not.toHaveBeenCalled();
  });

  it('excludes packages that failed to build, even though they never needed validation', async () => {
    const result = await buildValidation({
      buildResult: stateWith([
        {
          packageName: 'broken-pkg', packageType: 'Source', skipped: false, success: false,
        },
      ]),
    });

    expect(result.publishablePackages).toEqual([]);
  });

  it('excludes packages whose build was skipped (no source changes)', async () => {
    const result = await buildValidation({
      buildResult: stateWith([
        {
          packageName: 'unchanged-pkg', packageType: 'Source', skipped: true, success: true,
        },
      ]),
    });

    expect(result.publishablePackages).toEqual([]);
  });

  it('sets the publishable-packages output', async () => {
    await buildValidation({
      buildResult: stateWith([
        {
          packageName: 'pkg-a', packageType: 'Source', skipped: false, success: true,
        },
        {
          packageName: 'pkg-b', packageType: 'Source', skipped: true, success: true,
        },
      ]),
    });

    expect(core.setOutput).toHaveBeenCalledWith('publishable-packages', 'pkg-a');
  });

  it('narrows validation resolution to the requested subset of packages', async () => {
    mockResolve.mockResolvedValue(new Map([
      ['pkg-a', {checks: ['dependencies', 'deploy', 'test'], status: 'passed'}],
    ]));

    const result = await buildValidation({
      buildResult: stateWith([
        {
          packageName: 'pkg-a',
          packageType: 'Unlocked',
          pendingValidation: {
            devhub: 'devhub@test.com', operationType: 'package-version-request', packageName: 'pkg-a', packageVersionRequestId: 'req-a',
          },
          skipped: false,
          success: true,
        },
        {
          packageName: 'pkg-b',
          packageType: 'Unlocked',
          pendingValidation: {
            devhub: 'devhub@test.com', operationType: 'package-version-request', packageName: 'pkg-b', packageVersionRequestId: 'req-b',
          },
          skipped: false,
          success: true,
        },
      ]),
      packages: ['pkg-a'],
    });

    expect(mockResolve).toHaveBeenCalledWith(
      [expect.objectContaining({packageName: 'pkg-a'})],
      expect.anything(),
    );
    // pkg-b was never resolved — still pending, so not publishable this call.
    expect(result.publishablePackages).toEqual(['pkg-a']);
  });

  it('fails when build-result is not valid JSON', async () => {
    const result = await buildValidation({buildResult: 'not-json'});

    expect(result.publishablePackages).toEqual([]);
    expect(result.success).toBe(false);
    expect(core.setFailed).toHaveBeenCalled();
  });
});
