import {beforeEach, describe, expect, it, vi} from 'vitest';

// Mock @salesforce/core
vi.mock('@salesforce/core', () => ({
  Org: {
    create: vi.fn().mockResolvedValue({
      getConnection: vi.fn().mockReturnValue({}),
    }),
  },
}));

// Mock @b64/sfpm-core
vi.mock('@b64/sfpm-core', () => {
  class MockSfpmPackage {
    _metadata: any = {identity: {packageName: '', packageType: 'data'}, source: {}, content: {}, orchestration: {}, validation: {}};
    packageName: string;
    projectDirectory: string;
    stagingDirectory?: string;
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
      return this.stagingDirectory
        ? `${this.stagingDirectory}/${pkgPath}`
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
    Logger: undefined,
  };
});

import SfdmuDataInstaller from '../../src/sfdmu-data-installer.js';
import {SfpmDataPackage} from '@b64/sfpm-core';

describe('SfdmuDataInstaller', () => {
  let dataPackage: any;

  beforeEach(() => {
    dataPackage = new SfpmDataPackage('my-data', '/project');
    (dataPackage as any)._packageDefinition = {
      package: 'my-data',
      path: 'data',
      type: 'data',
      versionNumber: '1.0.0.0',
    };
  });

  it('should throw TypeError for non-data packages', () => {
    const badPackage = {constructor: {name: 'SfpmSourcePackage'}} as any;
    expect(() => new SfdmuDataInstaller('my-org', badPackage)).toThrow('incompatible package type');
  });

  it('should create installer for data packages', () => {
    const installer = new SfdmuDataInstaller('my-org', dataPackage);
    expect(installer).toBeDefined();
  });

  it('should connect to org', async () => {
    const installer = new SfdmuDataInstaller('my-org', dataPackage);
    const events: string[] = [];

    installer.on('connection:start', () => events.push('connection:start'));
    installer.on('connection:complete', () => events.push('connection:complete'));

    await installer.connect('my-org');

    expect(events).toContain('connection:start');
    expect(events).toContain('connection:complete');
  });
});
