import {
  afterEach, beforeEach, describe, expect, it, vi,
} from 'vitest';

import type {DependencyResolution} from '../../src/project/project-graph.js';
import type {OrchestrationResult, PackageResult} from '../../src/types/events.js';

import {GitService} from '../../src/git/git-service.js';
import {BuildOrchestrator} from '../../src/package/build-orchestrator.js';
import {PackageBuilder} from '../../src/package/package-builder.js';
import {ProjectGraph} from '../../src/project/project-graph.js';
import {VersionManager} from '../../src/project/version-manager.js';
import {DependencyError} from '../../src/types/errors.js';

// Mock external dependencies
vi.mock('../../src/package/package-builder.js');
vi.mock('../../src/git/git-service.js');
vi.mock('../../src/project/version-manager.js');

const mockLogger = {
  debug: vi.fn(),
  error: vi.fn(),
  info: vi.fn(),
  log: vi.fn(),
  trace: vi.fn(),
  warn: vi.fn(),
};

// Helper to create a mock ProjectConfig
function createMockProjectConfig(): any {
  return {
    getPackageConfig: vi.fn(),
    getProjectDefinition: vi.fn(),
  };
}

// Helper to create a simple DependencyResolution
function createResolution(
  levels: string[][],
  deps: Record<string, string[]> = {},
): DependencyResolution {
  const allNodes = new Map<string, any>();

  // Create nodes
  for (const level of levels) {
    for (const name of level) {
      allNodes.set(name, {
        dependencies: new Set(),
        dependents: new Set(),
        name,
      });
    }
  }

  // Wire up dependencies
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

describe('BuildOrchestrator', () => {
  let orchestrator: BuildOrchestrator;
  let mockProjectConfig: any;
  let mockResolution: DependencyResolution;
  let mockBuildPackage: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();

    mockProjectConfig = createMockProjectConfig();

    // Default: single-level resolution with two packages
    mockResolution = createResolution([['pkg-a', 'pkg-b']]);

    // Mock VersionManager to return a ProjectGraph with our resolution
    const mockGraph = {
      resolveDependencies: vi.fn().mockReturnValue(mockResolution),
    };
    vi.mocked(VersionManager.create).mockReturnValue({
      getGraph: () => mockGraph,
    } as any);

    // Mock GitService
    vi.mocked(GitService.initialize).mockResolvedValue({} as any);

    // Mock PackageBuilder
    mockBuildPackage = vi.fn().mockResolvedValue();
    vi.mocked(PackageBuilder).mockImplementation(function (this: any) {
      this.buildPackage = mockBuildPackage;
      this.on = vi.fn().mockReturnValue(this);
      this.removeAllListeners = vi.fn();
      this.emit = vi.fn();
      return this;
    } as any);

    orchestrator = new BuildOrchestrator(
      mockProjectConfig,
      {devHub: 'test-hub'},
      mockLogger,
      '/test/project',
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('buildAll', () => {
    it('should build all packages in single level concurrently', async () => {
      const result = await orchestrator.buildAll(['pkg-a', 'pkg-b']);

      expect(result.success).toBe(true);
      expect(result.results).toHaveLength(2);
      expect(result.failedPackages).toHaveLength(0);
      expect(result.skippedPackages).toHaveLength(0);
      expect(mockBuildPackage).toHaveBeenCalledTimes(2);
    });

    it('should respect dependency levels and build sequentially across levels', async () => {
      // A is leaf, B depends on A
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

      const result = await orchestrator.buildAll(['pkg-b']);

      expect(result.success).toBe(true);
      expect(result.results).toHaveLength(2);
      // Both should have been built
      expect(mockBuildPackage).toHaveBeenCalledTimes(2);
    });

    it('should skip dependents when a dependency fails', async () => {
      // A is leaf, B depends on A — A fails, so B should be skipped
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
      mockBuildPackage.mockRejectedValue(new Error('Build failed'));

      const result = await orchestrator.buildAll(['pkg-b']);

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

      await expect(orchestrator.buildAll(['pkg-a'])).rejects.toThrow(DependencyError);
    });

    it('should filter to requested packages when includeDependencies is false', async () => {
      // A is leaf, B depends on A. With includeDeps=false only B should be built.
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

      const noDepsOrchestrator = new BuildOrchestrator(
        mockProjectConfig,
        {devHub: 'test-hub', includeDependencies: false},
        mockLogger,
        '/test/project',
      );

      const result = await noDepsOrchestrator.buildAll(['pkg-b']);

      expect(result.results).toHaveLength(1);
      expect(result.results[0].packageName).toBe('pkg-b');
      expect(mockBuildPackage).toHaveBeenCalledTimes(1);
    });

    it('should handle rejected promises from package builds gracefully', async () => {
      mockBuildPackage
      .mockResolvedValueOnce()
      .mockRejectedValueOnce(new Error('Unexpected error'));

      const result = await orchestrator.buildAll(['pkg-a', 'pkg-b']);

      expect(result.success).toBe(false);
      expect(result.failedPackages).toHaveLength(1);
      const failedResult = result.results.find(r => !r.success);
      expect(failedResult?.error).toBe('Unexpected error');
    });

    it('should share a single GitService across all builders', async () => {
      await orchestrator.buildAll(['pkg-a', 'pkg-b']);

      // GitService.initialize should be called only once
      expect(GitService.initialize).toHaveBeenCalledTimes(1);
    });
  });

  describe('events', () => {
    it('should emit orchestration:start with package count and levels', async () => {
      const events: any[] = [];
      orchestrator.on('orchestration:start', e => events.push(e));

      await orchestrator.buildAll(['pkg-a', 'pkg-b']);

      expect(events).toHaveLength(1);
      expect(events[0].totalPackages).toBe(2);
      expect(events[0].totalLevels).toBe(1);
      expect(events[0].packageNames).toEqual(['pkg-a', 'pkg-b']);
    });

    it('should emit orchestration:complete with results', async () => {
      const events: any[] = [];
      orchestrator.on('orchestration:complete', e => events.push(e));

      await orchestrator.buildAll(['pkg-a', 'pkg-b']);

      expect(events).toHaveLength(1);
      expect(events[0].results).toHaveLength(2);
      expect(events[0].totalDuration).toBeGreaterThanOrEqual(0);
    });

    it('should emit orchestration:level:start and orchestration:level:complete', async () => {
      const levelStarts: any[] = [];
      const levelCompletes: any[] = [];
      orchestrator.on('orchestration:level:start', e => levelStarts.push(e));
      orchestrator.on('orchestration:level:complete', e => levelCompletes.push(e));

      await orchestrator.buildAll(['pkg-a', 'pkg-b']);

      expect(levelStarts).toHaveLength(1);
      expect(levelStarts[0].level).toBe(0);
      expect(levelCompletes).toHaveLength(1);
    });

    it('should emit orchestration:package:complete for each package', async () => {
      const packageCompletes: any[] = [];
      orchestrator.on('orchestration:package:complete', e => packageCompletes.push(e));

      await orchestrator.buildAll(['pkg-a', 'pkg-b']);

      expect(packageCompletes).toHaveLength(2);
      expect(packageCompletes.map(e => e.packageName).sort()).toEqual(['pkg-a', 'pkg-b']);
    });
  });
});
