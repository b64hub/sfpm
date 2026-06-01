import {beforeEach, describe, expect, it, vi} from 'vitest';

import {dependencyAnalysisTask} from '../../../../src/package/builders/tasks/dependency-analysis-task.js';
import {BuildError} from '../../../../src/types/errors.js';
import type {DependencyAnalyzer, DependencyReport} from '../../../../src/types/dependency-analysis.js';
import type {BuildTaskContext} from '../../../../src/package/builders/builder-registry.js';

describe('DependencyAnalysisTask', () => {
  let analyzer: DependencyAnalyzer;
  let analyzeMock: ReturnType<typeof vi.fn>;
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

    analyzeMock = vi.fn<DependencyAnalyzer['analyze']>();
    analyzer = {
      analyze: analyzeMock,
      initialize: vi.fn(),
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
      projectDirectory: '/workspace',
      sfpmPackage: {packageName: 'pkg-a'} as any,
    };
  });

  function createTask(report: DependencyReport, warnOnly = false) {
    analyzeMock.mockResolvedValue(report);
    return dependencyAnalysisTask({analyzer, warnOnly})(ctx);
  }

  it('returns void when no missing dependencies are found', async () => {
    const task = createTask({
      packageName: 'pkg-a',
      missingDependencies: [],
    });

    await expect(task.exec()).resolves.toBeUndefined();
    expect(analyzeMock).toHaveBeenCalledWith(ctx.sfpmPackage);
  });

  it('logs an info message for clean packages', async () => {
    const task = createTask({
      packageName: 'pkg-a',
      missingDependencies: [],
    });

    await task.exec();

    expect(logger.info).toHaveBeenCalledWith('No missing dependencies found for pkg-a');
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('throws BuildError when missing dependencies are found and warnOnly is false', async () => {
    const task = createTask({
      packageName: 'pkg-a',
      missingDependencies: [
        {
          packageName: 'pkg-b',
          references: [{referenceType: 'ApexClass', sourceFile: 'classes/MyClass.cls', symbol: 'SharedService'}],
        },
      ],
    });

    await expect(task.exec()).rejects.toThrow(BuildError);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('logs a warning instead of throwing when warnOnly is true', async () => {
    const task = createTask({
      packageName: 'pkg-a',
      missingDependencies: [
        {
          packageName: 'pkg-b',
          references: [{referenceType: 'ApexClass', sourceFile: 'classes/MyClass.cls', symbol: 'SharedService'}],
        },
      ],
    }, true);

    await expect(task.exec()).resolves.toBeUndefined();

    expect(logger.warn).toHaveBeenCalledWith([
      "Package 'pkg-a' has undeclared dependencies:",
      '  → pkg-b (referenced by 1 symbol(s))',
      '      SharedService in classes/MyClass.cls',
    ].join('\n'));
  });

  it('includes the formatted report in the BuildError message', async () => {
    const task = createTask({
      packageName: 'pkg-a',
      missingDependencies: [
        {
          packageName: 'pkg-b',
          references: [
            {referenceType: 'ApexClass', sourceFile: 'classes/MyClass.cls', symbol: 'SharedService'},
            {referenceType: 'ApexInterface', sourceFile: 'classes/OtherClass.cls', symbol: 'ISharedContract'},
          ],
        },
        {
          packageName: 'pkg-c',
          references: [{referenceType: 'CustomObject', sourceFile: 'objects/Invoice__c.object-meta.xml', symbol: 'Invoice__c'}],
        },
      ],
    });

    try {
      await task.exec();
      expect.unreachable('Expected task to throw');
    } catch (error) {
      expect(error).toBeInstanceOf(BuildError);
      expect(error).toMatchObject({
        buildStep: 'dependency-analysis',
        packageName: 'pkg-a',
      });
      expect((error as BuildError).message).toContain("Package 'pkg-a' has undeclared dependencies:");
      expect((error as BuildError).message).toContain('  → pkg-b (referenced by 2 symbol(s))');
      expect((error as BuildError).message).toContain('      SharedService in classes/MyClass.cls');
      expect((error as BuildError).message).toContain('      ISharedContract in classes/OtherClass.cls');
      expect((error as BuildError).message).toContain('  → pkg-c (referenced by 1 symbol(s))');
      expect((error as BuildError).message).toContain(
        '      Invoice__c in objects/Invoice__c.object-meta.xml',
      );
    }
  });
});
