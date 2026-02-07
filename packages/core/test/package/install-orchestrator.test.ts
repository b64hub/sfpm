import {
  afterEach, beforeEach, describe, expect, it, vi,
} from 'vitest';

import type {DependencyResolution} from '../../src/project/project-graph.js';

import {ArtifactService} from '../../src/artifacts/artifact-service.js';
import {InstallOrchestrator} from '../../src/package/install-orchestrator.js';
import PackageInstaller from '../../src/package/package-installer.js';
import {VersionManager} from '../../src/project/version-manager.js';
import {DependencyError} from '../../src/types/errors.js';

// Mock external dependencies
vi.mock('../../src/package/package-installer.js');
vi.mock('../../src/artifacts/artifact-service.js');
vi.mock('../../src/project/version-manager.js');
vi.mock('@salesforce/core', () => ({
  Org: {
    create: vi.fn().mockResolvedValue({
      getConnection: vi.fn().mockReturnValue({}),
      getUsername: vi.fn().mockReturnValue('test@example.com'),
    }),
  },
}));

const mockLogger = {
  debug: vi.fn(),
  error: vi.fn(),
  info: vi.fn(),
  log: vi.fn(),
  trace: vi.fn(),
  warn: vi.fn(),
};

function createMockProjectConfig(): any {
  return {
    getPackageConfig: vi.fn(),
    getProjectDefinition: vi.fn(),
  };
}

function createResolution(
  levels: string[][],
  deps: Record<string, string[]> = {},
): DependencyResolution {
  const allNodes = new Map<string, any>();

  for (const level of levels) {
    for (const name of level) {
      allNodes.set(name, {
        dependencies: new Set(),
        dependents: new Set(),
        name,
      });
    }
  }

  for (const [name, depNames] of Object.entries(deps)) {
    const node = allNodes.get(name);
    if (node) {
      for (const depName of depNames) {
        const depNode = allNodes.get(depName);
        if (depNode) {
          node.dependencies.add(depNode);
          depNode.dependents.add(node);
        }
      }
    }
  }

  return {
    allPackages: [...allNodes.values()],
    circularDependencies: undefined,
    levels: levels.map(level => level.map(name => allNodes.get(name)!)),
  };
}

describe('InstallOrchestrator', () => {
  let orchestrator: InstallOrchestrator;
  let mockProjectConfig: any;
  let mockResolution: DependencyResolution;
  let mockInstallPackage: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();

    mockProjectConfig = createMockProjectConfig();

    // Default: single level, two packages
    mockResolution = createResolution([['pkg-a', 'pkg-b']]);

    const mockGraph = {
      resolveDependencies: vi.fn().mockReturnValue(mockResolution),
    };
    vi.mocked(VersionManager.create).mockReturnValue({
      getGraph: () => mockGraph,
    } as any);

    // Mock ArtifactService
    vi.mocked(ArtifactService).mockImplementation(function (this: any) {
      this.preloadInstalledArtifacts = vi.fn().mockResolvedValue();
      this.clearCache = vi.fn();
      return this;
    } as any);

    // Mock PackageInstaller
    mockInstallPackage = vi.fn().mockResolvedValue({skipped: false});
    vi.mocked(PackageInstaller).mockImplementation(function (this: any) {
      this.installPackage = mockInstallPackage;
      this.on = vi.fn().mockReturnValue(this);
      this.removeAllListeners = vi.fn();
      this.emit = vi.fn();
      return this;
    } as any);

    orchestrator = new InstallOrchestrator(
      mockProjectConfig,
      {targetOrg: 'test@example.com'},
      mockLogger,
      '/test/project',
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('installAll', () => {
    it('should install all packages in single level concurrently', async () => {
      const result = await orchestrator.installAll(['pkg-a', 'pkg-b']);

      expect(result.success).toBe(true);
      expect(result.results).toHaveLength(2);
      expect(result.failedPackages).toHaveLength(0);
      expect(result.skippedPackages).toHaveLength(0);
      expect(mockInstallPackage).toHaveBeenCalledTimes(2);
    });

    it('should respect dependency levels and install sequentially across levels', async () => {
      mockResolution = createResolution(
        [['pkg-a'], ['pkg-b']],
        {'pkg-b': ['pkg-a']},
      );

      const mockGraph = {
        resolveDependencies: vi.fn().mockReturnValue(mockResolution),
      };
      vi.mocked(VersionManager.create).mockReturnValue({
        getGraph: () => mockGraph,
      } as any);

      const result = await orchestrator.installAll(['pkg-b']);

      expect(result.success).toBe(true);
      expect(result.results).toHaveLength(2);
      expect(mockInstallPackage).toHaveBeenCalledTimes(2);
    });

    it('should skip dependents when a dependency fails', async () => {
      mockResolution = createResolution(
        [['pkg-a'], ['pkg-b']],
        {'pkg-b': ['pkg-a']},
      );

      const mockGraph = {
        resolveDependencies: vi.fn().mockReturnValue(mockResolution),
      };
      vi.mocked(VersionManager.create).mockReturnValue({
        getGraph: () => mockGraph,
      } as any);

      // Make pkg-a fail
      mockInstallPackage.mockRejectedValue(new Error('Install failed'));

      const result = await orchestrator.installAll(['pkg-b']);

      expect(result.success).toBe(false);
      expect(result.failedPackages).toContain('pkg-a');
      expect(result.skippedPackages).toContain('pkg-b');

      const pkgBResult = result.results.find(r => r.packageName === 'pkg-b');
      expect(pkgBResult?.skipped).toBe(true);
    });

    it('should throw DependencyError on circular dependencies', async () => {
      const circularResolution: DependencyResolution = {
        allPackages: [],
        circularDependencies: [['pkg-a', 'pkg-b', 'pkg-a']],
        levels: [],
      };

      const mockGraph = {
        resolveDependencies: vi.fn().mockReturnValue(circularResolution),
      };
      vi.mocked(VersionManager.create).mockReturnValue({
        getGraph: () => mockGraph,
      } as any);

      await expect(orchestrator.installAll(['pkg-a'])).rejects.toThrow(DependencyError);
    });

    it('should filter to requested packages when includeDependencies is false', async () => {
      mockResolution = createResolution(
        [['pkg-a'], ['pkg-b']],
        {'pkg-b': ['pkg-a']},
      );

      const mockGraph = {
        resolveDependencies: vi.fn().mockReturnValue(mockResolution),
      };
      vi.mocked(VersionManager.create).mockReturnValue({
        getGraph: () => mockGraph,
      } as any);

      const noDepsOrchestrator = new InstallOrchestrator(
        mockProjectConfig,
        {includeDependencies: false, targetOrg: 'test@example.com'},
        mockLogger,
        '/test/project',
      );

      const result = await noDepsOrchestrator.installAll(['pkg-b']);

      expect(result.results).toHaveLength(1);
      expect(result.results[0].packageName).toBe('pkg-b');
      expect(mockInstallPackage).toHaveBeenCalledTimes(1);
    });

    it('should preload artifact cache before installing', async () => {
      await orchestrator.installAll(['pkg-a']);

      // ArtifactService should have been created and preloaded
      const artifactInstance = vi.mocked(ArtifactService).mock.results[0]?.value;
      expect(artifactInstance.preloadInstalledArtifacts).toHaveBeenCalledTimes(1);
    });

    it('should share org and artifact service across all installers', async () => {
      await orchestrator.installAll(['pkg-a', 'pkg-b']);

      // A single ArtifactService should be created
      expect(ArtifactService).toHaveBeenCalledTimes(1);
      // Two installers created, both receiving the same org and artifact service
      expect(PackageInstaller).toHaveBeenCalledTimes(2);
    });
  });

  describe('events', () => {
    it('should emit orchestration:start with package count and levels', async () => {
      const events: any[] = [];
      orchestrator.on('orchestration:start', e => events.push(e));

      await orchestrator.installAll(['pkg-a', 'pkg-b']);

      expect(events).toHaveLength(1);
      expect(events[0].totalPackages).toBe(2);
      expect(events[0].totalLevels).toBe(1);
    });

    it('should emit orchestration:complete with results', async () => {
      const events: any[] = [];
      orchestrator.on('orchestration:complete', e => events.push(e));

      await orchestrator.installAll(['pkg-a', 'pkg-b']);

      expect(events).toHaveLength(1);
      expect(events[0].results).toHaveLength(2);
      expect(events[0].totalDuration).toBeGreaterThanOrEqual(0);
    });

    it('should emit orchestration:package:complete for each package', async () => {
      const packageCompletes: any[] = [];
      orchestrator.on('orchestration:package:complete', e => packageCompletes.push(e));

      await orchestrator.installAll(['pkg-a', 'pkg-b']);

      expect(packageCompletes).toHaveLength(2);
      expect(packageCompletes.map(e => e.packageName).sort()).toEqual(['pkg-a', 'pkg-b']);
    });
  });
});
