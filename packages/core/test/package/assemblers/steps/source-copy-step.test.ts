import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import fs from 'fs-extra';
import os from 'node:os';
import path from 'node:path';

import {SourceCopyStep} from '../../../../src/package/assemblers/steps/source-copy-step.js';
import type {AssemblyOptions, AssemblyOutput} from '../../../../src/package/assemblers/types.js';

describe('SourceCopyStep', () => {
  let tmpDir: string;
  let sourceDir: string;
  let stagingDir: string;
  let mockProvider: any;
  let mockLogger: any;

  beforeEach(async () => {
    tmpDir = path.join(os.tmpdir(), `source-copy-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    sourceDir = path.join(tmpDir, 'project', 'force-app');
    stagingDir = path.join(tmpDir, 'staging');

    await fs.ensureDir(sourceDir);
    await fs.ensureDir(stagingDir);

    mockProvider = {
      projectDir: path.join(tmpDir, 'project'),
      getPackageDefinition: vi.fn().mockReturnValue({
        package: 'core',
        path: 'force-app',
      }),
    };

    mockLogger = {
      debug: vi.fn(),
      error: vi.fn(),
      info: vi.fn(),
      log: vi.fn(),
      trace: vi.fn(),
      warn: vi.fn(),
    };
  });

  afterEach(async () => {
    await fs.remove(tmpDir).catch(() => {});
  });

  function makeOutput(): AssemblyOutput {
    return {stagingDirectory: stagingDir};
  }

  it('should copy all files when no build ignore is configured', async () => {
    await fs.writeFile(path.join(sourceDir, 'MyClass.cls'), 'public class MyClass {}');
    await fs.writeFile(path.join(sourceDir, 'MyClass.cls-meta.xml'), '<ApexClass/>');

    const step = new SourceCopyStep('core', mockProvider, mockLogger);
    await step.execute({}, makeOutput());

    expect(await fs.pathExists(path.join(stagingDir, 'force-app', 'MyClass.cls'))).toBe(true);
    expect(await fs.pathExists(path.join(stagingDir, 'force-app', 'MyClass.cls-meta.xml'))).toBe(true);
  });

  it('should exclude files matching build ignore patterns', async () => {
    // Create source files
    await fs.ensureDir(path.join(sourceDir, 'classes'));
    await fs.writeFile(path.join(sourceDir, 'classes', 'KeepMe.cls'), 'public class KeepMe {}');
    await fs.writeFile(path.join(sourceDir, 'classes', 'KeepMe.cls-meta.xml'), '<ApexClass/>');
    await fs.ensureDir(path.join(sourceDir, 'testClasses'));
    await fs.writeFile(path.join(sourceDir, 'testClasses', 'TestOnly.cls'), '@isTest class TestOnly {}');

    // Create build ignore file
    const ignoreFilePath = path.join(tmpDir, 'project', '.forceignore.build');
    await fs.writeFile(ignoreFilePath, 'testClasses/\n');

    const options: AssemblyOptions = {
      ignoreFilesConfig: {build: '.forceignore.build'},
    };

    const step = new SourceCopyStep('core', mockProvider, mockLogger);
    await step.execute(options, makeOutput());

    // Kept
    expect(await fs.pathExists(path.join(stagingDir, 'force-app', 'classes', 'KeepMe.cls'))).toBe(true);
    // Excluded
    expect(await fs.pathExists(path.join(stagingDir, 'force-app', 'testClasses'))).toBe(false);
  });

  it('should exclude files matching wildcard patterns', async () => {
    await fs.ensureDir(path.join(sourceDir, 'lwc'));
    await fs.writeFile(path.join(sourceDir, 'lwc', 'component.js'), 'export default class {}');
    await fs.writeFile(path.join(sourceDir, 'lwc', 'component.test.js'), 'test');
    await fs.writeFile(path.join(sourceDir, 'lwc', 'helper.test.js'), 'test');

    const ignoreFilePath = path.join(tmpDir, 'project', '.forceignore.build');
    await fs.writeFile(ignoreFilePath, '*.test.js\n');

    const options: AssemblyOptions = {
      ignoreFilesConfig: {build: '.forceignore.build'},
    };

    const step = new SourceCopyStep('core', mockProvider, mockLogger);
    await step.execute(options, makeOutput());

    expect(await fs.pathExists(path.join(stagingDir, 'force-app', 'lwc', 'component.js'))).toBe(true);
    expect(await fs.pathExists(path.join(stagingDir, 'force-app', 'lwc', 'component.test.js'))).toBe(false);
    expect(await fs.pathExists(path.join(stagingDir, 'force-app', 'lwc', 'helper.test.js'))).toBe(false);
  });

  it('should warn and copy all files when build ignore file does not exist', async () => {
    await fs.writeFile(path.join(sourceDir, 'MyClass.cls'), 'public class MyClass {}');

    const options: AssemblyOptions = {
      ignoreFilesConfig: {build: '.forceignore.build'},
    };

    const step = new SourceCopyStep('core', mockProvider, mockLogger);
    await step.execute(options, makeOutput());

    // File should still be copied (graceful fallback)
    expect(await fs.pathExists(path.join(stagingDir, 'force-app', 'MyClass.cls'))).toBe(true);
    // Should have logged a warning
    expect(mockLogger.warn).toHaveBeenCalledWith(expect.stringContaining('not found'));
  });

  it('should handle empty build ignore file gracefully', async () => {
    await fs.writeFile(path.join(sourceDir, 'MyClass.cls'), 'public class MyClass {}');

    const ignoreFilePath = path.join(tmpDir, 'project', '.forceignore.build');
    await fs.writeFile(ignoreFilePath, '');

    const options: AssemblyOptions = {
      ignoreFilesConfig: {build: '.forceignore.build'},
    };

    const step = new SourceCopyStep('core', mockProvider, mockLogger);
    await step.execute(options, makeOutput());

    expect(await fs.pathExists(path.join(stagingDir, 'force-app', 'MyClass.cls'))).toBe(true);
  });

  it('should handle comments and blank lines in ignore file', async () => {
    await fs.ensureDir(path.join(sourceDir, 'classes'));
    await fs.writeFile(path.join(sourceDir, 'classes', 'Keep.cls'), 'class');
    await fs.ensureDir(path.join(sourceDir, 'testData'));
    await fs.writeFile(path.join(sourceDir, 'testData', 'file.json'), '{}');

    const ignoreFilePath = path.join(tmpDir, 'project', '.forceignore.build');
    await fs.writeFile(ignoreFilePath, [
      '# Exclude test data from build artifacts',
      '',
      'testData/',
      '',
    ].join('\n'));

    const options: AssemblyOptions = {
      ignoreFilesConfig: {build: '.forceignore.build'},
    };

    const step = new SourceCopyStep('core', mockProvider, mockLogger);
    await step.execute(options, makeOutput());

    expect(await fs.pathExists(path.join(stagingDir, 'force-app', 'classes', 'Keep.cls'))).toBe(true);
    expect(await fs.pathExists(path.join(stagingDir, 'force-app', 'testData'))).toBe(false);
  });

  it('should support negation patterns', async () => {
    await fs.writeFile(path.join(sourceDir, 'a.report'), 'report');
    await fs.writeFile(path.join(sourceDir, 'b.report'), 'report');
    await fs.writeFile(path.join(sourceDir, 'keep.cls'), 'class');

    const ignoreFilePath = path.join(tmpDir, 'project', '.forceignore.build');
    await fs.writeFile(ignoreFilePath, [
      '*.report',
      '!b.report',
    ].join('\n'));

    const options: AssemblyOptions = {
      ignoreFilesConfig: {build: '.forceignore.build'},
    };

    const step = new SourceCopyStep('core', mockProvider, mockLogger);
    await step.execute(options, makeOutput());

    // b.report is un-ignored by the negation rule
    expect(await fs.pathExists(path.join(stagingDir, 'force-app', 'b.report'))).toBe(true);
    // a.report is still excluded
    expect(await fs.pathExists(path.join(stagingDir, 'force-app', 'a.report'))).toBe(false);
    // cls file unaffected
    expect(await fs.pathExists(path.join(stagingDir, 'force-app', 'keep.cls'))).toBe(true);
  });

  it('should log excluded files at debug level', async () => {
    await fs.writeFile(path.join(sourceDir, 'excluded.tmp'), 'temp');

    const ignoreFilePath = path.join(tmpDir, 'project', '.forceignore.build');
    await fs.writeFile(ignoreFilePath, '*.tmp\n');

    const options: AssemblyOptions = {
      ignoreFilesConfig: {build: '.forceignore.build'},
    };

    const step = new SourceCopyStep('core', mockProvider, mockLogger);
    await step.execute(options, makeOutput());

    expect(mockLogger.debug).toHaveBeenCalledWith(
      expect.stringContaining('Excluded by build ignore: excluded.tmp'),
    );
  });
});
