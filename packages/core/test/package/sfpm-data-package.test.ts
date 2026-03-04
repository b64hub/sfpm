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
      package: 'my-data',
      path: 'data',
      versionNumber: '1.0.0.0',
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
    dataPackage.stagingDirectory = '/staging/area';
    expect(dataPackage.dataDirectory).toBe(path.join('/staging/area', 'data'));
  });

  it('should throw if no path defined', () => {
    const pkg = new SfpmDataPackage('no-path', tmpDir);
    expect(() => pkg.dataDirectory).toThrow('must have a path defined');
  });

  it('should calculate deterministic source hash', async () => {
    const hash1 = await dataPackage.calculateSourceHash();
    const hash2 = await dataPackage.calculateSourceHash();

    expect(hash1).toBe(hash2);
    expect(hash1).toHaveLength(64);
    expect(dataPackage.sourceHash).toBe(hash1);
  });

  it('should count files in data directory', async () => {
    const count = await dataPackage.countFiles();
    expect(count).toBe(2); // export.json + Account.csv
  });

  it('should produce correct toJson output', async () => {
    const json = await dataPackage.toJson();

    expect(json.identity.packageName).toBe('my-data');
    expect(json.identity.packageType).toBe(PackageType.Data);
    expect(json.content.dataDirectory).toBe('data');
    expect(json.content.fileCount).toBe(2);
    expect(json.source).toBeDefined();
    expect(json.orchestration).toBeDefined();
  });

  it('should expose versionNumber for DataDeployable', () => {
    dataPackage.version = '1.0.0.1';
    expect(dataPackage.versionNumber).toBe('1.0.0-1');
  });

  afterEach(async () => {
    if (tmpDir) await fs.remove(tmpDir).catch(() => {});
  });
});
