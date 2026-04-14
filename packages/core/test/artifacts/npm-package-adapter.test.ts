import {describe, expect, it} from 'vitest';

import {
  extractPackageVersionId,
  extractSourceHash,
  fromNpmPackageJson,
  toNpmPackageJson,
} from '../../src/artifacts/npm-package-adapter.js';
import {NpmPackageJson} from '../../src/types/npm.js';
import {PackageType} from '../../src/types/package.js';

/**
 * Creates a realistic NpmPackageJson as produced by ArtifactAssembler.
 * The sfpm property contains the nested SfpmPackageMetadataBase structure.
 */
function createUnlockedPackageJson(overrides?: Partial<NpmPackageJson>): NpmPackageJson {
  return {
    description: 'sfpm artifact',
    files: ['src/packages/sfpm-artifact/**'],
    keywords: ['sfpm', 'salesforce', 'unlocked'],
    license: 'UNLICENSED',
    name: '@b64hub/sfpm-artifact',
    repository: {
      type: 'git',
      url: 'https://github.com/b64hub/sfpm-bootstrap.git',
    },
    sfpm: {
      content: {
        metadataCount: 2,
        payload: {Package: {types: [], version: '65.0'}},
        testCoverage: 50,
      },
      isOrgDependent: false,
      orchestration: {
        build: {installationKeyBypass: true},
        install: {isTriggerAllTests: true},
      },
      packageId: '0HoJz00000001SLKAY',
      packageName: 'sfpm-artifact',
      packageType: PackageType.Unlocked,
      packageVersionId: '04tJz000000lZn7IAE',
      source: {
        branch: 'feat-orgs',
        commitSHA: 'f1dc9cd8e9521b01b07e021171dd7c0b18291682',
        sourceHash: '8dbb986ebe459f428313e9a07d7e1842361589acf2460aafb9bd38f58a99c960',
      },
      versionNumber: '0.1.0-2',
    } as any,
    version: '0.1.0',
    ...overrides,
  };
}

function createSourcePackageJson(): NpmPackageJson {
  return {
    name: '@myorg/my-source-pkg',
    sfpm: {
      orchestration: {},
      packageName: 'my-source-pkg',
      packageType: PackageType.Source,
      source: {
        branch: 'main',
        commitSHA: 'abc123',
        sourceHash: 'def456',
      },
      versionNumber: '1.0.0-1',
    } as any,
    version: '1.0.0',
  };
}

describe('npm-package-adapter', () => {
  describe('fromNpmPackageJson', () => {
    it('should extract metadata from nested sfpm structure', () => {
      const packageJson = createUnlockedPackageJson();
      const metadata = fromNpmPackageJson(packageJson);

      expect(metadata.packageName).toBe('sfpm-artifact');
      expect(metadata.packageType).toBe(PackageType.Unlocked);
      expect(metadata.versionNumber).toBe('0.1.0-2');
    });

    it('should preserve unlocked package identity fields', () => {
      const packageJson = createUnlockedPackageJson();
      const metadata = fromNpmPackageJson(packageJson);

      expect((metadata as any).packageId).toBe('0HoJz00000001SLKAY');
      expect((metadata as any).packageVersionId).toBe('04tJz000000lZn7IAE');
    });

    it('should reconstruct repositoryUrl from top-level repository field', () => {
      const packageJson = createUnlockedPackageJson();
      const metadata = fromNpmPackageJson(packageJson);

      expect(metadata.source.repositoryUrl).toBe('https://github.com/b64hub/sfpm-bootstrap.git');
    });

    it('should not overwrite existing repositoryUrl in sfpm.source', () => {
      const packageJson = createUnlockedPackageJson();
      // Simulate a package.json that still has repositoryUrl in sfpm.source
      (packageJson.sfpm as any).source.repositoryUrl = 'https://internal.repo.com';

      const metadata = fromNpmPackageJson(packageJson);
      expect(metadata.source.repositoryUrl).toBe('https://internal.repo.com');
    });

    it('should preserve source metadata', () => {
      const packageJson = createUnlockedPackageJson();
      const metadata = fromNpmPackageJson(packageJson);

      expect(metadata.source.branch).toBe('feat-orgs');
      expect(metadata.source.commitSHA).toBe('f1dc9cd8e9521b01b07e021171dd7c0b18291682');
      expect(metadata.source.sourceHash).toBe('8dbb986ebe459f428313e9a07d7e1842361589acf2460aafb9bd38f58a99c960');
    });

    it('should preserve orchestration metadata', () => {
      const packageJson = createUnlockedPackageJson();
      const metadata = fromNpmPackageJson(packageJson);

      expect(metadata.orchestration).toEqual({
        build: {installationKeyBypass: true},
        install: {isTriggerAllTests: true},
      });
    });

    it('should use top-level npm version when sfpm versionNumber is missing', () => {
      const packageJson = createSourcePackageJson();
      delete (packageJson.sfpm as any).versionNumber;

      const metadata = fromNpmPackageJson(packageJson);
      expect(metadata.versionNumber).toBe('1.0.0');
    });

    it('should handle source packages without packageVersionId', () => {
      const packageJson = createSourcePackageJson();
      const metadata = fromNpmPackageJson(packageJson);

      expect(metadata.packageName).toBe('my-source-pkg');
      expect(metadata.packageType).toBe(PackageType.Source);
      expect((metadata as any).packageVersionId).toBeUndefined();
    });

    it('should handle missing repository field gracefully', () => {
      const packageJson = createSourcePackageJson();
      const metadata = fromNpmPackageJson(packageJson);

      // No repository at top level, no repositoryUrl in source
      expect(metadata.source.repositoryUrl).toBeUndefined();
    });
  });

  describe('extractPackageVersionId', () => {
    it('should extract packageVersionId from unlocked package', () => {
      const packageJson = createUnlockedPackageJson();
      const versionId = extractPackageVersionId(packageJson);

      expect(versionId).toBe('04tJz000000lZn7IAE');
    });

    it('should return undefined for source packages', () => {
      const packageJson = createSourcePackageJson();
      const versionId = extractPackageVersionId(packageJson);

      expect(versionId).toBeUndefined();
    });

    it('should return undefined when sfpm is missing', () => {
      const packageJson = {name: '@test/pkg', version: '1.0.0'} as NpmPackageJson;
      const versionId = extractPackageVersionId(packageJson);

      expect(versionId).toBeUndefined();
    });
  });

  describe('extractSourceHash', () => {
    it('should extract sourceHash from sfpm metadata', () => {
      const packageJson = createUnlockedPackageJson();
      const hash = extractSourceHash(packageJson);

      expect(hash).toBe('8dbb986ebe459f428313e9a07d7e1842361589acf2460aafb9bd38f58a99c960');
    });

    it('should return undefined when no source metadata', () => {
      const packageJson = {name: '@test/pkg', version: '1.0.0'} as NpmPackageJson;
      const hash = extractSourceHash(packageJson);

      expect(hash).toBeUndefined();
    });
  });

  describe('toNpmPackageJson', () => {
    function createMockPackage(overrides?: Record<string, any>) {
      return {
        metadata: {
          packageName: 'my-pkg',
          packageType: PackageType.Unlocked,
          versionNumber: '1.0.0-1',
          source: {branch: 'main', repositoryUrl: 'https://github.com/test/repo.git'},
          orchestration: {},
        },
        name: 'my-pkg',
        npmName: '@myorg/my-pkg',
        packageDefinition: {path: 'force-app', versionDescription: 'My package'},
        packageName: 'my-pkg',
        toJson: async () => ({
          packageName: 'my-pkg',
          packageType: PackageType.Unlocked,
          versionNumber: '1.0.0-1',
          orchestration: {},
          source: {branch: 'main', repositoryUrl: 'https://github.com/test/repo.git'},
        }),
        type: PackageType.Unlocked,
        ...overrides,
      } as any;
    }

    it('should generate a valid NpmPackageJson with scoped name', async () => {
      const pkg = createMockPackage();
      const result = await toNpmPackageJson(pkg, '1.0.0-1', {});

      expect(result.name).toBe('@myorg/my-pkg');
      expect(result.version).toBe('1.0.0');
      expect(result.sfpm).toBeDefined();
      expect(result.sfpm.packageName).toBe('my-pkg');
      expect(result.sfpm.versionNumber).toBe('1.0.0-1');
    });

    it('should not include a main field', async () => {
      const pkg = createMockPackage();
      const result = await toNpmPackageJson(pkg, '1.0.0-1', {});

      expect(result).not.toHaveProperty('main');
    });

    it('should put repository at top level and remove from sfpm.source', async () => {
      const pkg = createMockPackage();
      const result = await toNpmPackageJson(pkg, '1.0.0-1', {});

      expect(result.repository).toEqual({type: 'git', url: 'https://github.com/test/repo.git'});
      expect(result.sfpm.source?.repositoryUrl).toBeUndefined();
    });

    it('should include author and license when provided', async () => {
      const pkg = createMockPackage();
      const result = await toNpmPackageJson(pkg, '1.0.0-1', {
        author: 'Test Author',
        license: 'MIT',
      });

      expect(result.author).toBe('Test Author');
      expect(result.license).toBe('MIT');
    });

    it('should default license to UNLICENSED', async () => {
      const pkg = createMockPackage();
      const result = await toNpmPackageJson(pkg, '1.0.0-1', {});

      expect(result.license).toBe('UNLICENSED');
    });

    it('should include keywords with package type', async () => {
      const pkg = createMockPackage();
      const result = await toNpmPackageJson(pkg, '1.0.0-1', {
        additionalKeywords: ['custom'],
      });

      expect(result.keywords).toContain('sfpm');
      expect(result.keywords).toContain('salesforce');
      expect(result.keywords).toContain('unlocked');
      expect(result.keywords).toContain('custom');
    });

    it('should include files with package source path', async () => {
      const pkg = createMockPackage();
      const result = await toNpmPackageJson(pkg, '1.0.0-1', {});

      expect(result.files).toContain('force-app/**');
      expect(result.files).toContain('sfdx-project.json');
    });

    it('should include managed dependencies when provided', async () => {
      const pkg = createMockPackage();
      const result = await toNpmPackageJson(pkg, '1.0.0-1', {
        managedDependencies: {'Nebula Logger@4.16.0': '04taA000005CtsHQAS'},
      });

      expect(result.managedDependencies).toEqual({'Nebula Logger@4.16.0': '04taA000005CtsHQAS'});
    });

    it('should omit managed deps when empty', async () => {
      const pkg = createMockPackage();
      const result = await toNpmPackageJson(pkg, '1.0.0-1', {});

      expect(result.managedDependencies).toBeUndefined();
    });

    it('should strip empty values from sfpm metadata', async () => {
      const pkg = createMockPackage({
        toJson: async () => ({
          content: {fields: {all: []}},
          packageName: 'my-pkg',
          packageType: PackageType.Unlocked,
          orchestration: {},
          source: {},
        }),
      });

      const result = await toNpmPackageJson(pkg, '1.0.0-1', {});
      const sfpm = result.sfpm;

      expect(sfpm.source).toBeUndefined();
      expect(sfpm.orchestration).toBeUndefined();
    });
  });
});
