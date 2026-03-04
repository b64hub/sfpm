import {beforeEach, describe, expect, it, vi} from 'vitest';
import {InstallerRegistry} from '../../../src/package/installers/installer-registry.js';
import {PackageType} from '../../../src/types/package.js';
import SfpmPackage from '../../../src/package/sfpm-package.js';

describe('InstallerRegistry — Data type support', () => {
  beforeEach(() => {
    (InstallerRegistry as any).installers = new Map();
  });

  it('should accept PackageType.Data for registration', () => {
    class DataInstaller {
      constructor(targetOrg: string, sfpmPackage: SfpmPackage) {}
      async connect(username: string): Promise<void> {}
      async exec(): Promise<void> {}
    }

    InstallerRegistry.register(PackageType.Data, DataInstaller as any);

    const installer = InstallerRegistry.getInstaller(PackageType.Data);
    expect(installer).toBe(DataInstaller);
  });

  it('should allow data and source installers to coexist', () => {
    class DataInstaller {
      constructor(targetOrg: string, sfpmPackage: SfpmPackage) {}
      async connect(username: string): Promise<void> {}
      async exec(): Promise<void> {}
    }

    class SourceInstaller {
      constructor(targetOrg: string, sfpmPackage: SfpmPackage) {}
      async connect(username: string): Promise<void> {}
      async exec(): Promise<void> {}
    }

    InstallerRegistry.register(PackageType.Data, DataInstaller as any);
    InstallerRegistry.register(PackageType.Source, SourceInstaller as any);

    expect(InstallerRegistry.getInstaller(PackageType.Data)).toBe(DataInstaller);
    expect(InstallerRegistry.getInstaller(PackageType.Source)).toBe(SourceInstaller);
  });
});
