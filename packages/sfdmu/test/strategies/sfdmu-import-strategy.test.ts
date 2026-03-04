import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {execSync} from 'node:child_process';
import fs from 'fs-extra';
import path from 'path';
import os from 'os';

// Mock child_process
vi.mock('node:child_process', () => ({
  execSync: vi.fn(),
}));

// Mock @b64/sfpm-core
vi.mock('@b64/sfpm-core', () => ({
  InstallationError: class extends Error {
    constructor(pkg: string, org: string, msg: string, opts?: any) {
      super(msg);
      if (opts?.cause) this.cause = opts.cause;
    }
  },
  Logger: undefined,
}));

import SfdmuImportStrategy from '../../src/strategies/sfdmu-import-strategy.js';
import type {DataDeployable} from '@b64/sfpm-core';

const mockedExecSync = vi.mocked(execSync);

describe('SfdmuImportStrategy', () => {
  let tmpDir: string;
  let dataDeployable: DataDeployable;

  async function createTmpData(): Promise<string> {
    const dir = path.join(os.tmpdir(), `sfdmu-strategy-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    await fs.ensureDir(dir);
    await fs.writeFile(
      path.join(dir, 'export.json'),
      JSON.stringify({
        objects: [
          {objectName: 'Account', query: 'SELECT Id, Name FROM Account', operation: 'Upsert'},
          {objectName: 'Contact', query: 'SELECT Id FROM Contact', operation: 'Insert'},
        ],
      }),
    );
    return dir;
  }

  beforeEach(async () => {
    vi.clearAllMocks();
    tmpDir = await createTmpData();
    dataDeployable = {
      dataDirectory: tmpDir,
      packageName: 'my-data',
      versionNumber: '1.0.0.1',
    };
  });

  afterEach(async () => {
    if (tmpDir) await fs.remove(tmpDir).catch(() => {});
  });

  it('should invoke sf sfdmu run with correct arguments', async () => {
    mockedExecSync.mockReturnValue('Account -- Upserted: 100 records\nContact -- Inserted: 50 records\n');

    const strategy = new SfdmuImportStrategy();
    const result = await strategy.execute(dataDeployable, 'my-sandbox');

    expect(mockedExecSync).toHaveBeenCalledTimes(1);
    const command = mockedExecSync.mock.calls[0][0] as string;
    expect(command).toContain('sf sfdmu run');
    expect(command).toContain('--sourceusername "csvfile"');
    expect(command).toContain('--targetusername "my-sandbox"');
    expect(command).toContain(`--path "${tmpDir}"`);
    expect(command).toContain('--noprompt');

    expect(result.success).toBe(true);
    expect(result.objectsProcessed).toBe(2);
  });

  it('should fall back to sfdx when sf command not found', async () => {
    // First call (sf) fails with command not found
    mockedExecSync.mockImplementationOnce(() => {
      const error: any = new Error('command not found');
      error.status = 127;
      throw error;
    });
    // Second call (sfdx) succeeds
    mockedExecSync.mockReturnValueOnce('Account -- Upserted: 10 records\n');

    const strategy = new SfdmuImportStrategy();
    const result = await strategy.execute(dataDeployable, 'my-sandbox');

    expect(mockedExecSync).toHaveBeenCalledTimes(2);
    const sfdxCommand = mockedExecSync.mock.calls[1][0] as string;
    expect(sfdxCommand).toContain('sfdx sfdmu:run');
    expect(result.success).toBe(true);
  });

  it('should throw InstallationError when both sf and sfdx fail with ENOENT', async () => {
    mockedExecSync.mockImplementation(() => {
      const error: any = new Error('command not found');
      error.status = 127;
      throw error;
    });

    const strategy = new SfdmuImportStrategy();
    await expect(strategy.execute(dataDeployable, 'my-sandbox')).rejects.toThrow('SFDMU is not installed');
  });

  it('should throw InstallationError when sfdmu execution fails', async () => {
    const error: any = new Error('Some SFDMU error');
    error.stderr = 'SFDMU error details';
    mockedExecSync.mockImplementation(() => {
      throw error;
    });

    const strategy = new SfdmuImportStrategy();
    await expect(strategy.execute(dataDeployable, 'my-sandbox')).rejects.toThrow('SFDMU import failed');
  });

  it('should emit data-import events', async () => {
    mockedExecSync.mockReturnValue('Account -- Upserted: 100 records\n');

    const strategy = new SfdmuImportStrategy();
    const events: string[] = [];

    strategy.on('data-import:start', () => events.push('start'));
    strategy.on('data-import:complete', () => events.push('complete'));

    await strategy.execute(dataDeployable, 'my-sandbox');

    expect(events).toEqual(['start', 'complete']);
  });

  it('should throw for per-object errors with detail in message', async () => {
    mockedExecSync.mockReturnValue(
      'Account -- Upserted: 100 records\nContact -- Inserted: 50 records\nOpportunity -- ERROR: Field mapping failed\n',
    );

    const strategy = new SfdmuImportStrategy();

    await expect(strategy.execute(dataDeployable, 'my-sandbox')).rejects.toThrow('Opportunity: Field mapping failed');
  });
});
