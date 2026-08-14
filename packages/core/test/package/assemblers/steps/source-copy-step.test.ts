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

  it('should copy all org subdirectories for org-aliased packages', async () => {
    // Setup org-aliased directory structure inside the source dir
    const defaultDir = path.join(sourceDir, 'default');
    const uatDir = path.join(sourceDir, 'uat');
    await fs.ensureDir(path.join(defaultDir, 'classes'));
    await fs.ensureDir(path.join(uatDir, 'classes'));
    await fs.writeFile(path.join(defaultDir, 'classes', 'DefaultClass.cls'), 'default class');
    await fs.writeFile(path.join(uatDir, 'classes', 'UatClass.cls'), 'uat class');

    // Mark package as org-aliased
    mockProvider.getPackageDefinition.mockReturnValue({
      package: 'core',
      packageOptions: {orgAliased: true},
      path: 'force-app',
    });

    const step = new SourceCopyStep('core', mockProvider, mockLogger);
    await step.execute({}, makeOutput());

    // Build stages the entire package including all env directories
    expect(await fs.pathExists(path.join(stagingDir, 'force-app', 'default', 'classes', 'DefaultClass.cls'))).toBe(true);
    expect(await fs.pathExists(path.join(stagingDir, 'force-app', 'uat', 'classes', 'UatClass.cls'))).toBe(true);
  });
});
