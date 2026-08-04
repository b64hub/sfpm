import {beforeEach, describe, expect, it, vi} from 'vitest';

import {compileValidationTask} from '../../../../src/package/builders/tasks/compile-validation-task.js';
import {BuildError} from '../../../../src/types/errors.js';
import type {LocalValidator, ValidationResult} from '../../../../src/types/local-validator.js';
import type {BuildTaskContext} from '../../../../src/package/builders/builder-registry.js';
import {SfpmMetadataPackage} from '../../../../src/package/sfpm-package.js';

// Minimal SfpmMetadataPackage stand-in that satisfies instanceof + hasApex
class FakeApexPackage extends SfpmMetadataPackage {
  get hasApex() { return true; }
  async componentCount() { return 1; }
  async ensureAnalyzed() {}
}

class FakeNoApexPackage extends SfpmMetadataPackage {
  get hasApex() { return false; }
  async componentCount() { return 0; }
  async ensureAnalyzed() {}
}

describe('CompileValidationTask', () => {
  let validator: LocalValidator;
  let compileMock: ReturnType<typeof vi.fn>;
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

    compileMock = vi.fn<LocalValidator['compile']>();
    validator = {
      checkAvailability: vi.fn(),
      checkDependencies: vi.fn(),
      compile: compileMock,
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
      sfpmPackage: new FakeApexPackage('pkg-a', '/workspace') as any,
    };
  });

  function makeResult(overrides: Partial<ValidationResult> = {}): ValidationResult {
    return {diagnostics: [], durationMs: 10, status: 'passed', ...overrides};
  }

  function createTask(result: ValidationResult, warnOnly = true) {
    compileMock.mockResolvedValue(result);
    return compileValidationTask({validator, warnOnly})(ctx);
  }

  describe('canRun()', () => {
    it('returns true when package has Apex', () => {
      const task = compileValidationTask({validator})(ctx);
      expect(task.canRun?.()).toBe(true);
    });

    it('returns false when package has no Apex', () => {
      ctx = {...ctx, sfpmPackage: new FakeNoApexPackage('pkg-a', '/workspace') as any};
      const task = compileValidationTask({validator})(ctx);
      expect(task.canRun?.()).toBe(false);
    });
  });

  it('calls compile with context resolved from provider', async () => {
    const task = createTask(makeResult());
    await task.exec();

    expect(compileMock).toHaveBeenCalledWith({
      packageId: 'pkg-a',
      packagePath: '/workspace/pkg-a/dist',
      projectRoot: '/workspace',
    });
  });

  it('returns void when compile passes', async () => {
    const task = createTask(makeResult({status: 'passed'}));
    await expect(task.exec()).resolves.toBeUndefined();
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('returns a warning when compile is skipped (validator unavailable)', async () => {
    const task = createTask(makeResult({status: 'skipped'}));
    await expect(task.exec()).resolves.toEqual({
      warnings: [{label: 'pkg-a', message: 'Local compile validation skipped — local compile validation unavailable'}],
    });
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('Compile validation skipped'));
  });

  it('logs each diagnostic with severity mapping', async () => {
    const task = createTask(makeResult({
      status: 'failed',
      diagnostics: [
        {message: 'Type mismatch',      severity: 'error',   filePath: 'classes/Foo.cls', line: 10},
        {message: 'Unused variable',    severity: 'warning', filePath: 'classes/Foo.cls'},
        {message: 'Consider refactoring', severity: 'info'},
      ],
    }));

    await task.exec(); // warnOnly=true, so no throw

    expect(logger.error).toHaveBeenCalledWith('[pkg-a] classes/Foo.cls:10 Type mismatch');
    expect(logger.warn).toHaveBeenCalledWith('[pkg-a] classes/Foo.cls Unused variable');
    expect(logger.info).toHaveBeenCalledWith('[pkg-a] Consider refactoring');
  });

  it('logs a warning summary and does not throw when warnOnly=true', async () => {
    const task = createTask(makeResult({
      status: 'failed',
      diagnostics: [{message: 'Compile error', severity: 'error'}],
    }), true);

    await expect(task.exec()).resolves.toEqual({
      warnings: [{label: 'pkg-a', message: 'Compile error'}],
    });
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("Compile validation failed for 'pkg-a'"));
  });

  it('throws BuildError when warnOnly=false and compile fails', async () => {
    const task = createTask(makeResult({
      status: 'failed',
      diagnostics: [{message: 'Compile error', severity: 'error'}],
    }), false);

    await expect(task.exec()).rejects.toThrow(BuildError);
  });

  it('throws BuildError when warnOnly=false and status is error', async () => {
    const task = createTask(makeResult({status: 'error'}), false);
    await expect(task.exec()).rejects.toThrow(BuildError);
  });
});
