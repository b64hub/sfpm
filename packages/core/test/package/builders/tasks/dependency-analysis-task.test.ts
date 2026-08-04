import {beforeEach, describe, expect, it, vi} from 'vitest';

import {dependencyAnalysisTask} from '../../../../src/package/builders/tasks/dependency-analysis-task.js';
import {BuildError} from '../../../../src/types/errors.js';
import type {DependencyResult, LocalValidator} from '../../../../src/types/local-validator.js';
import type {BuildTaskContext} from '../../../../src/package/builders/builder-registry.js';

describe('DependencyAnalysisTask', () => {
  let validator: LocalValidator;
  let checkDependenciesMock: ReturnType<typeof vi.fn>;
  let ctx: BuildTaskContext;
  let logger: {
    debug: ReturnType<typeof vi.fn>;
    error: ReturnType<typeof vi.fn>;
    info: ReturnType<typeof vi.fn>;
    trace: ReturnType<typeof vi.fn>;
    warn: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    vi.clearAllMocks();

    checkDependenciesMock = vi.fn<LocalValidator['checkDependencies']>();
    validator = {
      checkAvailability: vi.fn(),
      checkDependencies: checkDependenciesMock,
      compile: vi.fn(),
      test: vi.fn(),
    };

    logger = {
      debug: vi.fn(),
      error: vi.fn(),
      info: vi.fn(),
      trace: vi.fn(),
      warn: vi.fn(),
    };

    ctx = {
      logger,
      provider: {
        projectDir: '/workspace',
        getPackageBuildDirectory: vi.fn().mockReturnValue('/workspace/pkg-a/dist'),
      } as any,
      sfpmPackage: {packageName: 'pkg-a'} as any,
    };
  });

  function makeResult(overrides: Partial<DependencyResult> = {}): DependencyResult {
    return {
      caveats: [],
      durationMs: 10,
      status: 'passed',
      unresolved: [],
      violations: [],
      ...overrides,
    };
  }

  function createTask(result: DependencyResult, warnOnly = false) {
    checkDependenciesMock.mockResolvedValue(result);
    return dependencyAnalysisTask({validator, warnOnly})(ctx);
  }

  it('calls checkDependencies with context resolved from provider', async () => {
    const task = createTask(makeResult());
    await task.exec();

    expect(checkDependenciesMock).toHaveBeenCalledWith({
      packageId: 'pkg-a',
      packagePath: '/workspace/pkg-a/dist',
      projectRoot: '/workspace',
    });
  });

  it('logs info and returns when no violations found', async () => {
    const task = createTask(makeResult());
    await expect(task.exec()).resolves.toBeUndefined();
    expect(logger.info).toHaveBeenCalledWith('No boundary violations found for pkg-a');
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('logs info and returns when status is skipped', async () => {
    const task = createTask(makeResult({status: 'skipped'}));
    await expect(task.exec()).resolves.toBeUndefined();
    expect(logger.info).toHaveBeenCalledWith('Dependency check skipped for pkg-a');
  });

  it('throws BuildError on status error', async () => {
    const task = createTask(makeResult({status: 'error'}));
    await expect(task.exec()).rejects.toThrow(BuildError);
  });

  it('logs warning instead of throwing on status error when warnOnly is true', async () => {
    const task = createTask(makeResult({status: 'error'}), true);
    await expect(task.exec()).resolves.toEqual({
      warnings: [{label: 'pkg-a', message: 'Dependency check errored for pkg-a'}],
    });
    expect(logger.warn).toHaveBeenCalledWith('Dependency check errored for pkg-a');
  });

  it('throws BuildError with formatted message when violations found and warnOnly is false', async () => {
    const task = createTask(makeResult({
      status: 'failed',
      violations: [
        {fromMetadata: 'OrderService', fromPackage: 'pkg-a', toMetadata: 'StringFormatUtility', toPackage: 'pkg-utils'},
        {fromMetadata: 'OrderService', fromPackage: 'pkg-a', toMetadata: 'TypeFactory', toPackage: 'pkg-utils'},
        {fromMetadata: 'OrderService', fromPackage: 'pkg-a', toMetadata: 'Logger', toPackage: 'pkg-core'},
      ],
    }));

    try {
      await task.exec();
      expect.unreachable('Expected task to throw');
    } catch (error) {
      expect(error).toBeInstanceOf(BuildError);
      expect((error as BuildError).message).toContain("Package 'pkg-a' has undeclared dependencies:");
      expect((error as BuildError).message).toContain('→ pkg-utils (2 violation(s))');
      expect((error as BuildError).message).toContain('      OrderService → StringFormatUtility');
      expect((error as BuildError).message).toContain('→ pkg-core (1 violation(s))');
    }
  });

  it('logs warning instead of throwing when warnOnly is true', async () => {
    const task = createTask(makeResult({
      status: 'failed',
      violations: [
        {fromMetadata: 'OrderService', fromPackage: 'pkg-a', toMetadata: 'StringFormatUtility', toPackage: 'pkg-utils'},
      ],
    }), true);

    await expect(task.exec()).resolves.toEqual({
      warnings: [{label: 'pkg-a → pkg-utils', message: 'OrderService → StringFormatUtility'}],
    });
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('→ pkg-utils (1 violation(s))'));
  });

  it('includes unresolved count in the report when present', async () => {
    const task = createTask(makeResult({
      status: 'failed',
      violations: [{fromMetadata: 'A', fromPackage: 'pkg-a', toMetadata: 'B', toPackage: 'pkg-b'}],
      unresolved: ['System.Database', 'Schema.SObjectType'],
    }));

    try {
      await task.exec();
    } catch (error) {
      expect((error as BuildError).message).toContain('2 unresolved reference(s)');
    }
  });
});
