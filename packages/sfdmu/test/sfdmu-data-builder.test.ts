import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import fs from 'fs-extra';
import path from 'path';
import os from 'os';

// Mock @b64/sfpm-core to avoid full dependency resolution in unit tests
vi.mock('@b64/sfpm-core', () => {
  class MockSfpmPackage {
    _metadata: any = {identity: {packageName: '', packageType: 'data'}, source: {}, content: {}, orchestration: {}, validation: {}};
    packageName: string;
    projectDirectory: string;
    workingDirectory?: string;
    _packageDefinition?: any;

    constructor(name: string, dir: string) {
      this.packageName = name;
      this.projectDirectory = dir;
      this._metadata.identity.packageName = name;
    }

    get packageDefinition() { return this._packageDefinition; }
    set packageDefinition(val: any) { this._packageDefinition = val; }
  }

  class MockSfpmDataPackage extends MockSfpmPackage {
    get dataDirectory() {
      const pkgPath = this._packageDefinition?.path;
      if (!pkgPath) throw new Error('must have a path');
      return this.workingDirectory
        ? `${this.workingDirectory}/${pkgPath}`
        : `${this.projectDirectory}/${pkgPath}`;
    }

    get versionNumber() { return '1.0.0.1'; }
  }

  return {
    SfpmDataPackage: MockSfpmDataPackage,
    SfpmPackage: MockSfpmPackage,
    PackageType: {Data: 'data', Source: 'source', Unlocked: 'unlocked', Managed: 'managed', Diff: 'diff'},
    RegisterBuilder: () => (constructor: any) => constructor,
    RegisterInstaller: () => (constructor: any) => constructor,
    BuilderRegistry: {register: vi.fn(), getBuilder: vi.fn()},
    InstallerRegistry: {register: vi.fn(), getInstaller: vi.fn()},
    InstallationError: class extends Error {
      constructor(pkg: string, org: string, msg: string, opts?: any) {
        super(msg);
        if (opts?.cause) this.cause = opts.cause;
      }
    },
    AssembleArtifactTask: class {
      constructor() {}
      async exec() {}
    },
    Logger: undefined,
  };
});

import SfdmuDataBuilder from '../../src/sfdmu-data-builder.js';
import {SfpmDataPackage} from '@b64/sfpm-core';

describe('SfdmuDataBuilder', () => {
  let tmpDir: string;
  let dataPackage: any;

  async function createTmpProject(): Promise<string> {
    const dir = path.join(os.tmpdir(), `sfdmu-builder-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    const dataDir = path.join(dir, 'data');
    await fs.ensureDir(dataDir);
    return dir;
  }

  beforeEach(async () => {
    tmpDir = await createTmpProject();
    dataPackage = new SfpmDataPackage('my-data', tmpDir);
    (dataPackage as any)._packageDefinition = {
      package: 'my-data',
      path: 'data',
      type: 'data',
      versionNumber: '1.0.0.0',
    };
  });

  afterEach(async () => {
    if (tmpDir) await fs.remove(tmpDir).catch(() => {});
  });

  it('should throw TypeError for non-data packages', () => {
    const badPackage = {constructor: {name: 'SfpmSourcePackage'}} as any;
    expect(() => new SfdmuDataBuilder('/tmp', badPackage, {})).toThrow('incompatible package type');
  });

  it('should not throw on connect (no-op)', async () => {
    const builder = new SfdmuDataBuilder(path.join(tmpDir, 'data'), dataPackage, {});
    await expect(builder.connect('devhub')).resolves.not.toThrow();
  });

  it('should throw when export.json is missing', async () => {
    const builder = new SfdmuDataBuilder(path.join(tmpDir, 'data'), dataPackage, {});
    await expect(builder.exec()).rejects.toThrow('export.json not found');
  });

  it('should succeed when export.json is valid', async () => {
    const dataDir = path.join(tmpDir, 'data');
    await fs.writeFile(
      path.join(dataDir, 'export.json'),
      JSON.stringify({
        objects: [{objectName: 'Account', query: 'SELECT Id FROM Account', operation: 'Upsert'}],
      }),
    );

    const builder = new SfdmuDataBuilder(dataDir, dataPackage, {});
    await expect(builder.exec()).resolves.not.toThrow();
  });

  it('should throw when export.json has invalid JSON', async () => {
    const dataDir = path.join(tmpDir, 'data');
    await fs.writeFile(path.join(dataDir, 'export.json'), 'not json');

    const builder = new SfdmuDataBuilder(dataDir, dataPackage, {});
    await expect(builder.exec()).rejects.toThrow('invalid JSON');
  });

  it('should throw when export.json objects array is empty', async () => {
    const dataDir = path.join(tmpDir, 'data');
    await fs.writeFile(path.join(dataDir, 'export.json'), JSON.stringify({objects: []}));

    const builder = new SfdmuDataBuilder(dataDir, dataPackage, {});
    await expect(builder.exec()).rejects.toThrow('must not be empty');
  });

  it('should throw when export.json has no objects key', async () => {
    const dataDir = path.join(tmpDir, 'data');
    await fs.writeFile(path.join(dataDir, 'export.json'), JSON.stringify({foo: 'bar'}));

    const builder = new SfdmuDataBuilder(dataDir, dataPackage, {});
    await expect(builder.exec()).rejects.toThrow('must contain an "objects" array');
  });

  it('should emit task events during validation', async () => {
    const dataDir = path.join(tmpDir, 'data');
    await fs.writeFile(
      path.join(dataDir, 'export.json'),
      JSON.stringify({
        objects: [{objectName: 'Account', query: 'SELECT Id FROM Account', operation: 'Upsert'}],
      }),
    );

    const builder = new SfdmuDataBuilder(dataDir, dataPackage, {});
    const events: string[] = [];

    builder.on('task:start', () => events.push('start'));
    builder.on('task:complete', () => events.push('complete'));

    await builder.exec();

    expect(events).toContain('start');
    expect(events).toContain('complete');
  });
});
