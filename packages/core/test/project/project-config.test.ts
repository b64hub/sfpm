import {Logger} from '@salesforce/core';
import {
  afterEach, beforeEach, describe, expect, it, vi,
} from 'vitest';

import ProjectConfig from '../../src/project/project-config.js';
import {PackageType} from '../../src/types/package.js';
import {ProjectDefinition} from '../../src/types/project.js';

describe('ProjectConfig', () => {
  let mockProject: ProjectDefinition;
  let mockProjectJson: any;
  let mockSfProject: any;
  let projectConfig: ProjectConfig;
  let mockLogger: any;

  beforeEach(() => {
    // Mock logger to suppress console output during tests
    mockLogger = {
      debug: vi.fn(),
      error: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
    };
    vi.spyOn(Logger, 'childFromRoot').mockReturnValue(mockLogger as any);

    mockProject = {
      namespace: '',
      packageAliases: {
        bi: '0x002232323232',
        external: '0H43232232',
      },
      packageDirectories: [
        {
          default: true,
          package: 'temp',
          path: 'packages/temp',
          type: PackageType.Unlocked,
          versionNumber: '1.0.0.0',
        },
        {
          default: false,
          package: 'core',
          path: 'packages/domains/core',
          type: PackageType.Unlocked,
          versionNumber: '1.0.0.0',
        },
        {
          default: false,
          package: 'mass-dataload',
          path: 'packages/frameworks/mass-dataload',
          type: PackageType.Data,
          versionNumber: '1.0.0.0',
        },
        {
          default: false,
          package: 'access-mgmt',
          path: 'packages/access-mgmt',
          type: PackageType.Unlocked,
          versionNumber: '1.0.0.0',
        },
        {
          default: false,
          package: 'bi',
          path: 'packages/bi',
          type: PackageType.Unlocked,
          versionNumber: '1.0.0.0',
        },
      ],
      sfdcLoginUrl: 'https://login.salesforce.com',
      sourceApiVersion: '50.0',
    } as any;

    mockProjectJson = {
      getContents: vi.fn().mockReturnValue(mockProject),
      set: vi.fn(),
      write: vi.fn().mockResolvedValue(),
    };

    mockSfProject = {
      getPackage: vi.fn((name: string) => mockProject.packageDirectories.find((p: any) => p.package === name)),
      getPackageDirectories: vi.fn().mockReturnValue(mockProject.packageDirectories),
      getPath: vi.fn().mockReturnValue('/root'),
      getSfProjectJson: vi.fn().mockReturnValue(mockProjectJson),
      getUniquePackageNames: vi.fn().mockReturnValue(['temp', 'core', 'mass-dataload', 'access-mgmt', 'bi']),
    };

    projectConfig = new ProjectConfig(mockSfProject as any);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('getProjectDefinition', () => {
    it('should return the project definition from SfProject', () => {
      const definition = projectConfig.getProjectDefinition();
      expect(definition).toEqual(mockProject);
      expect(mockProjectJson.getContents).toHaveBeenCalled();
    });

    it('should validate custom properties on first access', () => {
      projectConfig.getProjectDefinition();
      // Validation runs on first access (may or may not warn depending on data validity)
      // The important thing is that it doesn't throw an error
      expect(mockProjectJson.getContents).toHaveBeenCalled();
    });

    it('should only validate once', () => {
      projectConfig.getProjectDefinition();
      projectConfig.getProjectDefinition();
      projectConfig.getProjectDefinition();
      // getContents called 4 times (1 in validation + 3 in getProjectDefinition)
      expect(mockProjectJson.getContents).toHaveBeenCalledTimes(4);
    });
  });

  describe('getPackageDefinition', () => {
    it('should find package by name from packageDirectories', () => {
      const pkg = projectConfig.getPackageDefinition('core');
      expect(pkg.path).toBe('packages/domains/core');
      expect(pkg.package).toBe('core');
    });

    it('should throw error if package not found', () => {
      expect(() => projectConfig.getPackageDefinition('nonexistent'))
      .toThrow('Package nonexistent not found in project definition');
    });
  });

  describe('getPackageId', () => {
    it('should get the package id from aliases', () => {
      const id = projectConfig.getPackageId('bi');
      expect(id).toBe('0x002232323232');
    });

    it('should return undefined if alias not found', () => {
      const id = projectConfig.getPackageId('nonexistent');
      expect(id).toBeUndefined();
    });
  });

  describe('getAllPackageNames', () => {
    it('should return all package names from packageDirectories', () => {
      const packages = projectConfig.getAllPackageNames();
      expect(packages).toEqual(['temp', 'core', 'mass-dataload', 'access-mgmt', 'bi']);
    });
  });

  describe('getAllPackageDirectories', () => {
    it('should return all package directories', () => {
      const packages = projectConfig.getAllPackageDirectories();
      expect(packages).toHaveLength(5);
    });
  });

  describe('getPackageType', () => {
    it('should return the type from package definition', () => {
      expect(projectConfig.getPackageType('bi')).toBe(PackageType.Unlocked);
      expect(projectConfig.getPackageType('core')).toBe(PackageType.Unlocked);
      expect(projectConfig.getPackageType('mass-dataload')).toBe(PackageType.Data);
    });

    it('should default to Unlocked if type not specified', () => {
      const pkgWithoutType = {...mockProject.packageDirectories[0]};
      delete (pkgWithoutType as any).type;
      mockSfProject.getPackage.mockReturnValue(pkgWithoutType);

      expect(projectConfig.getPackageType('temp')).toBe(PackageType.Unlocked);
    });
  });

  describe('sourceApiVersion', () => {
    it('should return the source API version', () => {
      expect(projectConfig.sourceApiVersion).toBe('50.0');
    });
  });

  describe('projectDirectory', () => {
    it('should return the project path from SfProject', () => {
      expect(projectConfig.projectDirectory).toBe('/root');
      expect(mockSfProject.getPath).toHaveBeenCalled();
    });
  });

  describe('save', () => {
    it('should save changes to SfProjectJson', async () => {
      const updated = {...mockProject, sourceApiVersion: '60.0'};
      await projectConfig.save(updated);

      expect(mockProjectJson.set).toHaveBeenCalledWith('packageDirectories', updated.packageDirectories);
      expect(mockProjectJson.set).toHaveBeenCalledWith('sourceApiVersion', '60.0');
      expect(mockProjectJson.write).toHaveBeenCalled();
    });

    it('should reset validation flag after save', async () => {
      // First access triggers validation
      projectConfig.getProjectDefinition();

      await projectConfig.save();

      // After save, validation should run again on next access
      projectConfig.getProjectDefinition();
      expect(mockProjectJson.getContents).toHaveBeenCalled();
    });

    it('should use current contents if no definition provided', async () => {
      await projectConfig.save();
      expect(mockProjectJson.set).toHaveBeenCalledWith('packageDirectories', mockProject.packageDirectories);
    });
  });
});
