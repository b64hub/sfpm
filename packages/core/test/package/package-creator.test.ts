import {describe, it, expect, vi, beforeEach} from 'vitest';
import {PackageCreator} from '../../src/package/package-creator.js';
import {BootstrapPackageConfig} from '../../src/types/bootstrap.js';

// Mock @salesforce/core
vi.mock('@salesforce/core', () => ({
  Org: class {
    static create = vi.fn();
    getConnection = vi.fn();
    isDevHubOrg = vi.fn().mockReturnValue(true);
  },
  SfProject: class {
    static resolve = vi.fn();
  },
}));

// Mock @salesforce/packaging
vi.mock('@salesforce/packaging', () => ({
  Package: {
    create: vi.fn(),
  },
}));

// Mock fs-extra
vi.mock('fs-extra', () => ({
  default: {
    readJson: vi.fn(),
    writeJson: vi.fn(),
  },
}));

// Mock package-service
const mockListAllPackages = vi.fn().mockResolvedValue([]);

vi.mock('../../src/package/package-service.js', () => ({
  PackageService: class MockPackageService {
    listAllPackages = mockListAllPackages;
  },
}));

import {Org, SfProject} from '@salesforce/core';
import {Package as SfPackage} from '@salesforce/packaging';
import fs from 'fs-extra';

describe('PackageCreator', () => {
  let creator: PackageCreator;
  let mockOrg: any;
  let mockLogger: any;
  let mockConnection: any;

  const testConfig: BootstrapPackageConfig = {
    dependencies: [],
    description: 'Test package',
    isOrgDependent: false,
    name: 'test-package',
    path: 'test-package',
  };

  const orgDependentConfig: BootstrapPackageConfig = {
    dependencies: ['test-package'],
    description: 'Org-dependent package',
    isOrgDependent: true,
    name: 'test-orgs',
    path: 'test-orgs',
  };

  beforeEach(() => {
    vi.clearAllMocks();

    mockConnection = {
      tooling: {query: vi.fn()},
    };

    mockOrg = {
      getConnection: vi.fn().mockReturnValue(mockConnection),
      isDevHubOrg: vi.fn().mockReturnValue(true),
    };

    mockLogger = {
      debug: vi.fn(),
      error: vi.fn(),
      info: vi.fn(),
      log: vi.fn(),
      trace: vi.fn(),
      warn: vi.fn(),
    };

    creator = new PackageCreator(mockOrg, mockLogger);
  });

  describe('queryExistingPackages', () => {
    it('should return matching packages from DevHub', async () => {
      const mockPackages = [
        {ContainerOptions: 'Unlocked', Description: '', Id: '0Ho000001', IsOrgDependent: false, Name: 'test-package', NamespacePrefix: ''},
        {ContainerOptions: 'Unlocked', Description: '', Id: '0Ho000002', IsOrgDependent: false, Name: 'other-package', NamespacePrefix: ''},
      ];

      mockListAllPackages.mockResolvedValue(mockPackages);

      const result = await creator.queryExistingPackages(['test-package']);

      expect(result.size).toBe(1);
      expect(result.get('test-package')?.Id).toBe('0Ho000001');
    });

    it('should return empty map when no packages match', async () => {
      mockListAllPackages.mockResolvedValue([]);

      const result = await creator.queryExistingPackages(['test-package']);

      expect(result.size).toBe(0);
    });

    it('should emit query events', async () => {
      mockListAllPackages.mockResolvedValue([]);

      const events: string[] = [];
      creator.on('package:query:start', () => events.push('start'));
      creator.on('package:query:complete', () => events.push('complete'));

      await creator.queryExistingPackages(['test-package']);

      expect(events).toEqual(['start', 'complete']);
    });
  });

  describe('createPackage', () => {
    it('should create a Package2 record via @salesforce/packaging', async () => {
      vi.mocked(SfPackage.create).mockResolvedValue({Id: '0Ho000099'} as any);
      vi.mocked(SfProject.resolve).mockResolvedValue({} as any);

      const result = await creator.createPackage(testConfig, '/tmp/project');

      expect(result).toBe('0Ho000099');
      expect(SfPackage.create).toHaveBeenCalledWith(
        mockConnection,
        expect.anything(),
        expect.objectContaining({
          name: 'test-package',
          orgDependent: false,
          packageType: 'Unlocked',
        }),
      );
    });

    it('should pass orgDependent=true for org-dependent packages', async () => {
      vi.mocked(SfPackage.create).mockResolvedValue({Id: '0Ho000100'} as any);
      vi.mocked(SfProject.resolve).mockResolvedValue({} as any);

      await creator.createPackage(orgDependentConfig, '/tmp/project');

      expect(SfPackage.create).toHaveBeenCalledWith(
        mockConnection,
        expect.anything(),
        expect.objectContaining({
          orgDependent: true,
        }),
      );
    });

    it('should emit create events', async () => {
      vi.mocked(SfPackage.create).mockResolvedValue({Id: '0Ho000099'} as any);
      vi.mocked(SfProject.resolve).mockResolvedValue({} as any);

      const events: string[] = [];
      creator.on('package:create:start', () => events.push('start'));
      creator.on('package:create:complete', () => events.push('complete'));

      await creator.createPackage(testConfig, '/tmp/project');

      expect(events).toEqual(['start', 'complete']);
    });
  });

  describe('updateProjectAliases', () => {
    it('should add package alias to sfdx-project.json', async () => {
      vi.mocked(fs.readJson).mockResolvedValue({
        packageAliases: {},
        packageDirectories: [],
      });

      await creator.updateProjectAliases('/tmp/project', 'test-package', '0Ho000099');

      expect(fs.writeJson).toHaveBeenCalledWith(
        '/tmp/project/sfdx-project.json',
        expect.objectContaining({
          packageAliases: {'test-package': '0Ho000099'},
        }),
        {spaces: 4},
      );
    });

    it('should create packageAliases when it does not exist', async () => {
      vi.mocked(fs.readJson).mockResolvedValue({
        packageDirectories: [],
      });

      await creator.updateProjectAliases('/tmp/project', 'test-package', '0Ho000099');

      expect(fs.writeJson).toHaveBeenCalledWith(
        '/tmp/project/sfdx-project.json',
        expect.objectContaining({
          packageAliases: {'test-package': '0Ho000099'},
        }),
        {spaces: 4},
      );
    });

    it('should emit alias update event', async () => {
      vi.mocked(fs.readJson).mockResolvedValue({packageAliases: {}});

      const events: string[] = [];
      creator.on('package:alias:update', () => events.push('update'));

      await creator.updateProjectAliases('/tmp/project', 'test-package', '0Ho000099');

      expect(events).toEqual(['update']);
    });
  });

  describe('ensurePackages', () => {
    it('should reuse existing packages without creating', async () => {
      mockListAllPackages.mockResolvedValue([
        {ContainerOptions: 'Unlocked', Description: '', Id: '0Ho000001', IsOrgDependent: false, Name: 'test-package', NamespacePrefix: ''},
      ]);
      vi.mocked(fs.readJson).mockResolvedValue({packageAliases: {}});

      const shouldCreate = vi.fn();

      const results = await creator.ensurePackages([testConfig], '/tmp/project', shouldCreate);

      expect(results).toHaveLength(1);
      expect(results[0].created).toBe(false);
      expect(results[0].packageId).toBe('0Ho000001');
      expect(shouldCreate).not.toHaveBeenCalled();
    });

    it('should create missing packages when approved', async () => {
      mockListAllPackages.mockResolvedValue([]);
      vi.mocked(SfPackage.create).mockResolvedValue({Id: '0Ho000099'} as any);
      vi.mocked(SfProject.resolve).mockResolvedValue({} as any);
      vi.mocked(fs.readJson).mockResolvedValue({packageAliases: {}});

      const shouldCreate = vi.fn().mockResolvedValue(true);

      const results = await creator.ensurePackages([testConfig], '/tmp/project', shouldCreate);

      expect(results).toHaveLength(1);
      expect(results[0].created).toBe(true);
      expect(results[0].packageId).toBe('0Ho000099');
      expect(shouldCreate).toHaveBeenCalledWith('test-package');
    });

    it('should throw when creation is declined', async () => {
      mockListAllPackages.mockResolvedValue([]);

      const shouldCreate = vi.fn().mockResolvedValue(false);

      await expect(
        creator.ensurePackages([testConfig], '/tmp/project', shouldCreate),
      ).rejects.toThrow('creation was declined');
    });

    it('should update project aliases for all packages', async () => {
      mockListAllPackages.mockResolvedValue([
        {ContainerOptions: 'Unlocked', Description: '', Id: '0Ho000001', IsOrgDependent: false, Name: 'test-package', NamespacePrefix: ''},
      ]);
      vi.mocked(SfPackage.create).mockResolvedValue({Id: '0Ho000002'} as any);
      vi.mocked(SfProject.resolve).mockResolvedValue({} as any);
      vi.mocked(fs.readJson).mockResolvedValue({packageAliases: {}});

      const shouldCreate = vi.fn().mockResolvedValue(true);

      const results = await creator.ensurePackages(
        [testConfig, orgDependentConfig],
        '/tmp/project',
        shouldCreate,
      );

      expect(results).toHaveLength(2);
      expect(results[0]).toEqual({created: false, name: 'test-package', packageId: '0Ho000001'});
      expect(results[1]).toEqual({created: true, name: 'test-orgs', packageId: '0Ho000002'});
      expect(fs.writeJson).toHaveBeenCalledTimes(2);
    });
  });
});
