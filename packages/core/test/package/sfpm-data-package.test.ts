import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import path from 'path';
import fs from 'fs-extra';
import os from 'os';

import {SfpmDataPackage} from '../../src/package/sfpm-package.js';
import {PackageType} from '../../src/types/package.js';

describe('SfpmDataPackage', () => {
  let tmpDir: string;
  let dataPackage: SfpmDataPackage;

  async function createTmpProject(): Promise<string> {
    const dir = path.join(os.tmpdir(), `sfpm-data-pkg-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    const dataDir = path.join(dir, 'data');
    await fs.ensureDir(dataDir);
    await fs.writeFile(path.join(dataDir, 'export.json'), JSON.stringify({objects: [{objectName: 'Account', query: 'SELECT Id FROM Account', operation: 'Upsert'}]}));
    await fs.writeFile(path.join(dataDir, 'Account.csv'), 'Id,Name\n001,Acme');
    return dir;
  }

  beforeEach(async () => {
    tmpDir = await createTmpProject();
    dataPackage = new SfpmDataPackage('my-data', tmpDir);
    dataPackage.packageDefinition = {
      name: 'my-data',
      path: 'data',
      version: '1.0.0',
      type: PackageType.Data,
    } as any;
  });

  it('should set package type to Data', () => {
    expect(dataPackage.type).toBe(PackageType.Data);
  });

  it('should resolve dataDirectory from project source', () => {
    expect(dataPackage.dataDirectory).toBe(path.join(tmpDir, 'data'));
  });

  it('should resolve dataDirectory from staging when staged', () => {
    dataPackage.workingDirectory = '/staging/area';
    expect(dataPackage.dataDirectory).toBe(path.join('/staging/area', 'data'));
  });

  it('should throw if no path defined', () => {
    const pkg = new SfpmDataPackage('no-path', tmpDir);
    expect(() => pkg.dataDirectory).toThrow('must have a path defined');
  });

  it('should count files in data directory', async () => {
    const count = await dataPackage.componentCount();
    expect(count).toBe(2); // export.json + Account.csv
  });

  it('should expose flat properties for serialization', () => {
    expect(dataPackage.packageName).toBe('my-data');
    expect(dataPackage.type).toBe(PackageType.Data);
    expect(dataPackage.orchestration).toBeDefined();
  });

  it('should expose versionNumber for DataDeployable', () => {
    dataPackage.version = '1.0.0.1';
    expect(dataPackage.versionNumber).toBe('1.0.0-1');
  });

  afterEach(async () => {
    if (tmpDir) await fs.remove(tmpDir).catch(() => {});
  });
});
