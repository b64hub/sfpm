import {describe, it, expect, vi, beforeEach} from 'vitest';
import {PackageCreator} from '../../src/package/package-creator.js';
import {BootstrapPackageConfig} from '../../src/types/bootstrap.js';

// Hoist mock fns so they're available inside vi.mock factory (which is hoisted)
const {mockCreatePackageFromConfig, mockQueryExistingPackages, mockEnsurePackages} = vi.hoisted(() => ({
  mockCreatePackageFromConfig: vi.fn(),
  mockEnsurePackages: vi.fn(),
  mockQueryExistingPackages: vi.fn().mockResolvedValue(new Map()),
}));

// Mock @salesforce/core (Org is only used to pass to PackageManager.getInstance)
vi.mock('@salesforce/core', () => ({
  Org: class {
    static create = vi.fn();
    getConnection = vi.fn();
    getUsername = vi.fn().mockReturnValue('test@devhub.com');
    isDevHubOrg = vi.fn().mockReturnValue(true);
  },
}));

// Mock PackageManager — PackageCreator delegates all work here
vi.mock('../../src/package/package-manager.js', () => ({
  default: {
    getInstance: vi.fn().mockReturnValue({
      createPackageFromConfig: mockCreatePackageFromConfig,
      ensurePackages: mockEnsurePackages,
      queryExistingPackages: mockQueryExistingPackages,
    }),
  },
}));

import {Org} from '@salesforce/core';
import PackageManager from '../../src/package/package-manager.js';

describe('PackageCreator', () => {
  let creator: PackageCreator;
  let mockOrg: any;
  let mockLogger: any;

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

    mockOrg = {
      getConnection: vi.fn(),
      getUsername: vi.fn().mockReturnValue('test@devhub.com'),
      isDevHubOrg: vi.fn().mockReturnValue(true),
    };

    mockLogger = {
      debug: vi.fn(),
      error: vi.fn(),
      info: vi.fn(),
      trace: vi.fn(),
      warn: vi.fn(),
    };

    // Reset per-test defaults
    mockQueryExistingPackages.mockResolvedValue(new Map());

    creator = new PackageCreator(mockOrg, mockLogger);
  });

  describe('queryExistingPackages', () => {
    it('should return matching packages from PackageManager', async () => {
      const mockMap = new Map([
        ['test-package', {ContainerOptions: 'Unlocked', Id: '0Ho000001', Name: 'test-package'}],
      ]);
      mockQueryExistingPackages.mockResolvedValue(mockMap);

      const result = await creator.queryExistingPackages(['test-package']);

      expect(result.size).toBe(1);
      expect(result.get('test-package')?.Id).toBe('0Ho000001');
      expect(PackageManager.getInstance).toHaveBeenCalledWith(mockOrg, mockLogger);
      expect(mockQueryExistingPackages).toHaveBeenCalledWith(['test-package']);
    });

    it('should return empty map when no packages match', async () => {
      mockQueryExistingPackages.mockResolvedValue(new Map());

      const result = await creator.queryExistingPackages(['test-package']);

      expect(result.size).toBe(0);
    });

    it('should emit query events', async () => {
      mockQueryExistingPackages.mockResolvedValue(new Map());

      const events: string[] = [];
      creator.on('package:query:start', () => events.push('start'));
      creator.on('package:query:complete', () => events.push('complete'));

      await creator.queryExistingPackages(['test-package']);

      expect(events).toEqual(['start', 'complete']);
    });
  });

  describe('createPackage', () => {
    it('should delegate to PackageManager.createPackageFromConfig', async () => {
      mockCreatePackageFromConfig.mockResolvedValue('0Ho000099');

      const result = await creator.createPackage(testConfig, '/tmp/project');

      expect(result).toBe('0Ho000099');
      expect(PackageManager.getInstance).toHaveBeenCalledWith(mockOrg, mockLogger);
      expect(mockCreatePackageFromConfig).toHaveBeenCalledWith(testConfig, '/tmp/project');
    });

    it('should pass org-dependent config through unchanged', async () => {
      mockCreatePackageFromConfig.mockResolvedValue('0Ho000100');

      await creator.createPackage(orgDependentConfig, '/tmp/project');

      expect(mockCreatePackageFromConfig).toHaveBeenCalledWith(orgDependentConfig, '/tmp/project');
    });

    it('should emit create events', async () => {
      mockCreatePackageFromConfig.mockResolvedValue('0Ho000099');

      const events: string[] = [];
      creator.on('package:create:start', () => events.push('start'));
      creator.on('package:create:complete', () => events.push('complete'));

      await creator.createPackage(testConfig, '/tmp/project');

      expect(events).toEqual(['start', 'complete']);
    });
  });

  describe('ensurePackages', () => {
    let mockProvider: any;

    beforeEach(() => {
      mockProvider = {updatePackageConfig: vi.fn().mockResolvedValue(undefined)};
    });

    it('should delegate to PackageManager.ensurePackages', async () => {
      const expectedResults = [{created: false, name: 'test-package', packageId: '0Ho000001'}];
      mockEnsurePackages.mockResolvedValue(expectedResults);

      const shouldCreate = vi.fn().mockResolvedValue(true);
      const results = await creator.ensurePackages([testConfig], mockProvider, '/tmp/project', shouldCreate);

      expect(results).toEqual(expectedResults);
      expect(mockEnsurePackages).toHaveBeenCalledWith([testConfig], mockProvider, '/tmp/project', shouldCreate);
    });

    it('should propagate errors from PackageManager', async () => {
      mockEnsurePackages.mockRejectedValue(new Error('creation was declined'));

      await expect(
        creator.ensurePackages([testConfig], mockProvider, '/tmp/project', vi.fn().mockResolvedValue(false)),
      ).rejects.toThrow('creation was declined');
    });
  });
});
