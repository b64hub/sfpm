import {
  beforeEach, describe, expect, it, vi,
} from 'vitest';

import {PackageBuilder} from '../../src/package/package-builder.js';
import {PackageType} from '../../src/types/package.js';

// ============================================================================
// Hoisted mocks (accessible inside vi.mock factories)
// ============================================================================

const {SfpmMetadataPackageStub, mockBuilderInstance, mockPackageFactoryFn, mockRepo} = vi.hoisted(() => {
  const _mockRepo = {
    checkSourceHash: vi.fn(),
    getDistDir: vi.fn().mockReturnValue('/project/packages/my-pkg/dist'),
    getPackageVersionId: vi.fn(),
    hasArtifact: vi.fn().mockReturnValue(true),
  };

  const _mockBuilderInstance = {
    connect: vi.fn().mockResolvedValue(undefined),
    exec: vi.fn().mockResolvedValue({}),
    tasks: [] as any[],
  };

  // Dynamically set by tests before each run
  let _packageType = 'source';
  const _mockPackageFactoryFn = {
    get packageType() { return _packageType; },
    set packageType(v: string) { _packageType = v; },
    create(name: string) {
      return {
        _content: {},
        _packageDefinition: {path: 'force-app'},
        componentCount: vi.fn().mockResolvedValue(10),
        name: `@test/${name}`,
        orchestration: {},
        packageDefinition: {path: 'force-app'},
        packageName: name,
        projectDirectory: '/project',
        scope: '@test',
        setBuildNumber: vi.fn(),
        source: {},
        type: _packageType,
        updateContent: vi.fn(),
        markAnalyzed: vi.fn(),
        version: '1.0.0',
        workingDirectory: undefined,
      };
    },
  };

  return {
    SfpmMetadataPackageStub: class SfpmMetadataPackageStub {},
    mockBuilderInstance: _mockBuilderInstance,
    mockPackageFactoryFn: _mockPackageFactoryFn,
    mockRepo: _mockRepo,
  };
});

vi.mock('../../src/artifacts/artifact-repository.js', () => ({
  ArtifactRepository: function ArtifactRepository() { return mockRepo; },
}));

vi.mock('../../src/utils/workspace-path.js', () => ({
  resolvePackageWorkspacePath: vi.fn().mockReturnValue('/project/packages/my-pkg'),
}));

vi.mock('../../src/utils/source-hasher.js', () => ({
  SourceHasher: {
    calculate: vi.fn().mockResolvedValue('abc123'),
  },
}));

vi.mock('../../src/package/builders/builder-registry.js', async (importOriginal) => {
  const original = await importOriginal() as any;
  return {
    ...original,
    builderFactory: vi.fn().mockReturnValue(mockBuilderInstance),
  };
});

// Stub class for instanceof checks in needsBuild()
vi.mock('../../src/package/sfpm-package.js', () => {
  return {
    SfpmMetadataPackage: SfpmMetadataPackageStub,
    PackageFactory: function PackageFactory() {
      return {
        createFromName: (name: string) => {
          const pkg = Object.create(SfpmMetadataPackageStub.prototype);
          return Object.assign(pkg, mockPackageFactoryFn.create(name));
        },
      };
    },
  };
});

vi.mock('../../src/package/assemblers/package-assembler.js', () => ({
  default: function PackageAssembler() {
    return {
      assemble: vi.fn().mockResolvedValue({
        componentCount: 10,
        stagingDirectory: '/project/packages/my-pkg/dist',
      }),
    };
  },
}));

vi.mock('../../src/lifecycle/lifecycle-engine.js', () => ({
  LifecycleEngine: {
    getInstance: vi.fn(),
    isInitialized: vi.fn().mockReturnValue(false),
  },
}));

vi.mock('../../src/package/analyzers/analyzer-registry.js', () => ({
  AnalyzerRegistry: {
    getAnalyzers: vi.fn().mockReturnValue([]),
  },
}));

vi.mock('@salesforce/core', () => ({
  Org: {
    create: vi.fn().mockResolvedValue({
      getConnection: vi.fn().mockReturnValue({}),
      getUsername: vi.fn().mockReturnValue('test@devhub.com'),
      isDevHubOrg: vi.fn().mockReturnValue(true),
    }),
  },
}));

import {Org} from '@salesforce/core';
import {builderFactory} from '../../src/package/builders/builder-registry.js';

// ============================================================================
// Helpers
// ============================================================================

const mockProvider: any = {
  getPackageDefinition: vi.fn().mockReturnValue({
    name: 'my-pkg',
    path: 'force-app',
    type: 'source',
    version: '1.0.0',
  }),
  projectDir: '/project',
};

const mockLogger: any = {
  debug: vi.fn(),
  error: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
};

// ============================================================================
// Tests
// ============================================================================

describe('PackageBuilder', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockPackageFactoryFn.packageType = PackageType.Source;
    mockBuilderInstance.exec.mockResolvedValue({});
    mockBuilderInstance.tasks = [];
    mockRepo.checkSourceHash.mockResolvedValue(undefined);
    mockRepo.getPackageVersionId.mockReturnValue(undefined);
  });

  // ==========================================================================
  // --source-only routing
  // ==========================================================================

  describe('--source-only routing', () => {
    it('should route unlocked packages through source builder when sourceOnly is true', async () => {
      mockPackageFactoryFn.packageType = PackageType.Unlocked;

      const builder = new PackageBuilder(mockProvider, {
        sourceOnly: true,
        validation: 'org',
      }, mockLogger);

      await builder.build('my-pkg');

      expect((builderFactory as any).mock.calls[0][4]).toBe(PackageType.Source);
    });

    it('should NOT route source packages differently when sourceOnly is true', async () => {
      mockPackageFactoryFn.packageType = PackageType.Source;

      const builder = new PackageBuilder(mockProvider, {
        sourceOnly: true,
        validation: 'org',
      }, mockLogger);

      await builder.build('my-pkg');

      expect((builderFactory as any).mock.calls[0][4]).toBe(undefined);
    });

    it('should route unlocked through source builder when validation is local (no org)', async () => {
      mockPackageFactoryFn.packageType = PackageType.Unlocked;

      const builder = new PackageBuilder(mockProvider, {
        validation: 'local',
      }, mockLogger);

      await builder.build('my-pkg');

      expect((builderFactory as any).mock.calls[0][4]).toBe(PackageType.Source);
    });

    it('should route unlocked through source builder when validation is none', async () => {
      mockPackageFactoryFn.packageType = PackageType.Unlocked;

      const builder = new PackageBuilder(mockProvider, {
        validation: 'none',
      }, mockLogger);

      await builder.build('my-pkg');

      expect((builderFactory as any).mock.calls[0][4]).toBe(PackageType.Source);
    });

    it('should use normal unlocked builder when validation is org and sourceOnly is false', async () => {
      mockPackageFactoryFn.packageType = PackageType.Unlocked;

      const builder = new PackageBuilder(mockProvider, {
        devhubUsername: 'hub@test.com',
        validation: 'org',
      }, mockLogger);

      await builder.build('my-pkg');

      expect((builderFactory as any).mock.calls[0][4]).toBe(undefined);
    });
  });

  // ==========================================================================
  // Org resolution
  // ==========================================================================

  describe('org resolution', () => {
    it('should resolve DevHub for unlocked packages with org validation', async () => {
      mockPackageFactoryFn.packageType = PackageType.Unlocked;

      const builder = new PackageBuilder(mockProvider, {
        devhubUsername: 'hub@test.com',
        validation: 'org',
      }, mockLogger);

      await builder.build('my-pkg');

      const resolvedOrg = await (Org.create as any).mock.results[0]?.value;
      expect(mockBuilderInstance.connect).toHaveBeenCalledWith(resolvedOrg);
    });

    it('should resolve buildOrg for source packages with org validation', async () => {
      mockPackageFactoryFn.packageType = PackageType.Source;

      const builder = new PackageBuilder(mockProvider, {
        buildOrg: 'build@test.com',
        validation: 'org',
      }, mockLogger);

      await builder.build('my-pkg');

      const resolvedOrg = await (Org.create as any).mock.results[0]?.value;
      expect(mockBuilderInstance.connect).toHaveBeenCalledWith(resolvedOrg);
    });

    it('should resolve buildOrg for unlocked packages when sourceOnly is true', async () => {
      mockPackageFactoryFn.packageType = PackageType.Unlocked;

      const builder = new PackageBuilder(mockProvider, {
        buildOrg: 'build@test.com',
        sourceOnly: true,
        validation: 'org',
      }, mockLogger);

      await builder.build('my-pkg');

      // Should use buildOrg (not devhubUsername) because sourceOnly
      const resolvedOrg = await (Org.create as any).mock.results[0]?.value;
      expect(mockBuilderInstance.connect).toHaveBeenCalledWith(resolvedOrg);
    });

    it('should not connect to org when validation is local', async () => {
      const builder = new PackageBuilder(mockProvider, {
        validation: 'local',
      }, mockLogger);

      await builder.build('my-pkg');

      expect(mockBuilderInstance.connect).not.toHaveBeenCalled();
    });

    it('should not connect to org when validation is none', async () => {
      const builder = new PackageBuilder(mockProvider, {
        validation: 'none',
      }, mockLogger);

      await builder.build('my-pkg');

      expect(mockBuilderInstance.connect).not.toHaveBeenCalled();
    });
  });

  // ==========================================================================
  // needsBuild — source hash checks
  // ==========================================================================

  describe('needsBuild — source hash', () => {
    it('should skip build when source hash matches', async () => {
      mockRepo.checkSourceHash.mockResolvedValue({
        artifactPath: '/project/packages/my-pkg/dist',
        latestVersion: '1.0.0',
      });

      const builder = new PackageBuilder(mockProvider, {}, mockLogger);
      await builder.build('my-pkg');

      expect(builderFactory).not.toHaveBeenCalled();
    });

    it('should proceed when source hash differs', async () => {
      mockRepo.checkSourceHash.mockResolvedValue(undefined);

      const builder = new PackageBuilder(mockProvider, {}, mockLogger);
      await builder.build('my-pkg');

      expect(builderFactory).toHaveBeenCalled();
    });

    it('should proceed when force is true despite hash match', async () => {
      mockRepo.checkSourceHash.mockResolvedValue({
        artifactPath: '/project/packages/my-pkg/dist',
        latestVersion: '1.0.0',
      });

      const builder = new PackageBuilder(mockProvider, {force: true}, mockLogger);
      await builder.build('my-pkg');

      expect(builderFactory).toHaveBeenCalled();
    });
  });

  // ==========================================================================
  // needsBuild — manifest completeness
  // ==========================================================================

  describe('needsBuild — manifest completeness', () => {
    it('should rebuild unlocked package when manifest has no packageVersionId and validation is org', async () => {
      mockPackageFactoryFn.packageType = PackageType.Unlocked;

      mockRepo.checkSourceHash.mockResolvedValue({
        artifactPath: '/project/packages/my-pkg/dist',
        latestVersion: '1.0.0',
      });
      mockRepo.getPackageVersionId.mockReturnValue(undefined);

      const builder = new PackageBuilder(mockProvider, {
        devhubUsername: 'hub@test.com',
        validation: 'org',
      }, mockLogger);

      await builder.build('my-pkg');

      expect(builderFactory).toHaveBeenCalled();
      expect(mockLogger.info).toHaveBeenCalledWith(
        expect.stringContaining('existing build has no packageVersionId'),
      );
    });

    it('should rebuild unlocked package when manifest has no packageVersionId and validation is full', async () => {
      mockPackageFactoryFn.packageType = PackageType.Unlocked;

      mockRepo.checkSourceHash.mockResolvedValue({
        artifactPath: '/project/packages/my-pkg/dist',
        latestVersion: '1.0.0',
      });
      mockRepo.getPackageVersionId.mockReturnValue(undefined);

      const builder = new PackageBuilder(mockProvider, {
        devhubUsername: 'hub@test.com',
        validation: 'full',
      }, mockLogger);

      await builder.build('my-pkg');

      expect(builderFactory).toHaveBeenCalled();
    });

    it('should skip unlocked build when manifest HAS packageVersionId and hash matches', async () => {
      mockPackageFactoryFn.packageType = PackageType.Unlocked;

      mockRepo.checkSourceHash.mockResolvedValue({
        artifactPath: '/project/packages/my-pkg/dist',
        latestVersion: '1.0.0',
      });
      mockRepo.getPackageVersionId.mockReturnValue('04tXXXXXXXXXXXXX');

      const builder = new PackageBuilder(mockProvider, {
        devhubUsername: 'hub@test.com',
        validation: 'org',
      }, mockLogger);

      await builder.build('my-pkg');

      expect(builderFactory).not.toHaveBeenCalled();
    });

    it('should NOT check packageVersionId when sourceOnly is true', async () => {
      mockPackageFactoryFn.packageType = PackageType.Unlocked;

      mockRepo.checkSourceHash.mockResolvedValue({
        artifactPath: '/project/packages/my-pkg/dist',
        latestVersion: '1.0.0',
      });
      // No packageVersionId — but sourceOnly doesn't need one
      mockRepo.getPackageVersionId.mockReturnValue(undefined);

      const builder = new PackageBuilder(mockProvider, {
        sourceOnly: true,
        validation: 'org',
      }, mockLogger);

      await builder.build('my-pkg');

      // Should skip — sourceOnly doesn't require packageVersionId
      expect(builderFactory).not.toHaveBeenCalled();
    });

    it('should NOT check packageVersionId when validation is local', async () => {
      mockPackageFactoryFn.packageType = PackageType.Unlocked;

      mockRepo.checkSourceHash.mockResolvedValue({
        artifactPath: '/project/packages/my-pkg/dist',
        latestVersion: '1.0.0',
      });
      mockRepo.getPackageVersionId.mockReturnValue(undefined);

      const builder = new PackageBuilder(mockProvider, {
        validation: 'local',
      }, mockLogger);

      await builder.build('my-pkg');

      expect(builderFactory).not.toHaveBeenCalled();
    });

    it('should NOT check packageVersionId for source packages', async () => {
      mockPackageFactoryFn.packageType = PackageType.Source;

      mockRepo.checkSourceHash.mockResolvedValue({
        artifactPath: '/project/packages/my-pkg/dist',
        latestVersion: '1.0.0',
      });
      mockRepo.getPackageVersionId.mockReturnValue(undefined);

      const builder = new PackageBuilder(mockProvider, {
        buildOrg: 'build@test.com',
        validation: 'org',
      }, mockLogger);

      await builder.build('my-pkg');

      // Source packages don't need packageVersionId — should skip
      expect(builderFactory).not.toHaveBeenCalled();
    });
  });

  // ==========================================================================
  // Validation level — analyzer gating
  // ==========================================================================

  describe('validation level — analyzer gating', () => {
    it('should run analyzers when validation is full', async () => {
      const {AnalyzerRegistry} = await import('../../src/package/analyzers/analyzer-registry.js');

      const builder = new PackageBuilder(mockProvider, {
        validation: 'full',
      }, mockLogger);

      await builder.build('my-pkg');

      expect(AnalyzerRegistry.getAnalyzers).toHaveBeenCalled();
    });

    it('should run analyzers when validation is local', async () => {
      const {AnalyzerRegistry} = await import('../../src/package/analyzers/analyzer-registry.js');

      const builder = new PackageBuilder(mockProvider, {
        validation: 'local',
      }, mockLogger);

      await builder.build('my-pkg');

      expect(AnalyzerRegistry.getAnalyzers).toHaveBeenCalled();
    });

    it('should run analyzers when validation is org', async () => {
      const {AnalyzerRegistry} = await import('../../src/package/analyzers/analyzer-registry.js');

      const builder = new PackageBuilder(mockProvider, {
        buildOrg: 'build@test.com',
        validation: 'org',
      }, mockLogger);

      await builder.build('my-pkg');

      expect(AnalyzerRegistry.getAnalyzers).toHaveBeenCalled();
    });

    it('should run content analyzers even when validation is none', async () => {
      const {AnalyzerRegistry} = await import('../../src/package/analyzers/analyzer-registry.js');
      vi.mocked(AnalyzerRegistry.getAnalyzers).mockClear();

      const builder = new PackageBuilder(mockProvider, {
        validation: 'none',
      }, mockLogger);

      await builder.build('my-pkg');

      // Content analyzers always run — they enrich the package model
      // with data needed for deployment (test classes, FHT fields, etc.)
      expect(AnalyzerRegistry.getAnalyzers).toHaveBeenCalled();
    });
  });
});
