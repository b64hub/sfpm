import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Mock external dependencies
vi.mock('@actions/core', () => ({
  error: vi.fn(),
  getInput: vi.fn(),
  info: vi.fn(),
  setFailed: vi.fn(),
  setOutput: vi.fn(),
  warning: vi.fn(),
}));

const packageDefinitions: Record<string, {path: string; type: string}> = {
  'pkg-a': {path: 'packages/pkg-a', type: 'Unlocked'},
  'pkg-b': {path: 'packages/pkg-b', type: 'Source'},
};

vi.mock('@b64hub/sfpm-core', () => ({
  DIST_DIR: 'dist',
  ProjectService: {
    getInstance: vi.fn().mockResolvedValue({
      getDefinitionProvider: () => ({
        getAllPackageNames: () => Object.keys(packageDefinitions),
        getPackageDefinition: (name: string) => packageDefinitions[name],
        getPackageDir: (name: string) => packageDefinitions[name]?.path,
      }),
    }),
  },
}));

import * as core from '@actions/core';

import {buildTurboAggregate} from '../src/build-turbo-aggregate.js';

let projectDir: string;

function writePackage(name: string, orchestrationResult: unknown): void {
  const pkgDir = path.join(projectDir, packageDefinitions[name].path);
  fs.mkdirSync(path.join(pkgDir, 'dist'), {recursive: true});
  fs.writeFileSync(path.join(pkgDir, 'package.json'), JSON.stringify({name: `@scope/${name}`}));
  fs.writeFileSync(path.join(pkgDir, 'dist', 'build-result.json'), JSON.stringify(orchestrationResult));
}

function writeTurboSummary(taskStatuses: Record<string, string>): void {
  const runsDir = path.join(projectDir, '.turbo', 'runs');
  fs.mkdirSync(runsDir, {recursive: true});
  const tasks = Object.entries(taskStatuses).map(([taskId, status]) => ({cache: {status}, taskId}));
  fs.writeFileSync(path.join(runsDir, 'run.json'), JSON.stringify({tasks}));
}

describe('buildTurboAggregate', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sfpm-turbo-aggregate-'));
  });

  afterEach(() => {
    fs.rmSync(projectDir, {force: true, recursive: true});
  });

  it('trusts a fresh (cache MISS) result, including its pending validation', async () => {
    writePackage('pkg-a', {
      duration: 1000,
      failedPackages: [],
      results: [{
        duration: 1000,
        packageName: 'pkg-a',
        result: {devhub: 'devhub@test.com', operationType: 'package-version-request', packageName: 'pkg-a', packageVersionRequestId: 'req-1'},
        skipped: false,
        success: true,
      }],
      skippedPackages: [],
      success: true,
    });
    writePackage('pkg-b', {
      duration: 500, failedPackages: [], results: [{duration: 500, packageName: 'pkg-b', skipped: false, success: true}], skippedPackages: [], success: true,
    });
    writeTurboSummary({'@scope/pkg-a#sfpm:build': 'MISS', '@scope/pkg-b#sfpm:build': 'MISS'});

    const result = await buildTurboAggregate({projectDir});

    expect(result.success).toBe(true);
    expect(result.packages).toEqual([
      {
        packageName: 'pkg-a',
        packageType: 'Unlocked',
        pendingValidation: {devhub: 'devhub@test.com', operationType: 'package-version-request', packageName: 'pkg-a', packageVersionRequestId: 'req-1'},
        skipped: false,
        success: true,
      },
      {
        packageName: 'pkg-b', packageType: 'Source', pendingValidation: undefined, skipped: false, success: true,
      },
    ]);
  });

  it('overrides a cache HIT to skipped, dropping any stale pending validation from the replayed file', async () => {
    // This file was replayed by turbo from a previous run — it still claims
    // a real build with a pending validation, even though nothing ran.
    writePackage('pkg-a', {
      duration: 1000,
      failedPackages: [],
      results: [{
        duration: 1000,
        packageName: 'pkg-a',
        result: {devhub: 'devhub@test.com', operationType: 'package-version-request', packageName: 'pkg-a', packageVersionRequestId: 'stale-req'},
        skipped: false,
        success: true,
      }],
      skippedPackages: [],
      success: true,
    });
    writeTurboSummary({'@scope/pkg-a#sfpm:build': 'HIT'});

    const result = await buildTurboAggregate({packages: ['pkg-a'], projectDir});

    expect(result.packages).toEqual([
      {
        packageName: 'pkg-a', packageType: 'Unlocked', skipped: true, success: true,
      },
    ]);
  });

  it('fails the aggregation when a package has no build result on disk', async () => {
    writeTurboSummary({});

    const result = await buildTurboAggregate({packages: ['pkg-a'], projectDir});

    expect(result.success).toBe(false);
    expect(result.failedPackages).toEqual(['pkg-a']);
    expect(core.setFailed).toHaveBeenCalled();
  });

  it('throws when no turbo run summary is present', async () => {
    await expect(buildTurboAggregate({packages: ['pkg-a'], projectDir})).rejects.toThrow(/turbo run summary/);
  });
});
