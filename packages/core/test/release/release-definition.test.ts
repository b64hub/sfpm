import {mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {
  afterEach, beforeEach, describe, expect, it,
} from 'vitest';

import {
  readReleaseDefinition,
  RELEASE_DIR,
  type ReleaseDefinition,
  writeReleaseDefinition,
} from '../../src/release/release-definition.js';

describe('release-definition YAML round-trip', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'release-test-'));
  });

  afterEach(() => {
    rmSync(tempDir, {force: true, recursive: true});
  });

  it('round-trips a complete ReleaseDefinition exactly', () => {
    const original: ReleaseDefinition = {
      options: {
        force: false,
        includeDependencies: true,
        regressionTest: true,
        testLevel: 'RunLocalTests',
        unlocked: {
          installationKeys: {
            'managed-pkg': 'installation-key-12345',
          },
        },
      },
      packages: [
        {name: '@org/core-objects', version: '1.4.0'},
        {name: '@org/sales-flow', version: '2.1.0'},
        {name: 'simple-pkg', version: '0.5.0'},
      ],
      ref: 'main',
      release: 'summer-2025',
    };

    const filePath = join(tempDir, 'release', 'summer-2025.yaml');
    writeReleaseDefinition(filePath, original);
    const read = readReleaseDefinition(filePath);

    expect(read).toEqual(original);
  });

  it('round-trips a minimal ReleaseDefinition (only required fields)', () => {
    const minimal: ReleaseDefinition = {
      packages: [{name: 'pkg-a', version: '1.0.0'}],
      release: 'minimal',
    };

    const filePath = join(tempDir, 'minimal.yaml');
    writeReleaseDefinition(filePath, minimal);
    const read = readReleaseDefinition(filePath);

    expect(read).toEqual(minimal);
  });

  it('creates parent directories as needed', () => {
    const filePath = join(tempDir, 'a', 'b', 'c', 'release.yaml');
    const def: ReleaseDefinition = {
      packages: [{name: 'pkg', version: '1.0.0'}],
      release: 'test',
    };

    expect(() => writeReleaseDefinition(filePath, def)).not.toThrow();
    const read = readReleaseDefinition(filePath);
    expect(read.release).toBe('test');
  });

  it('exports RELEASE_DIR constant', () => {
    expect(RELEASE_DIR).toBe('release');
  });
});

// eslint-disable-next-line mocha/max-top-level-suites
describe('release-definition validation', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'release-test-'));
  });

  afterEach(() => {
    rmSync(tempDir, {force: true, recursive: true});
  });

  it('rejects a YAML with missing required "release" field', () => {
    const filePath = join(tempDir, 'invalid.yaml');
    // Write invalid YAML directly
    writeFileSync(filePath, 'packages:\n  - name: pkg\n    version: 1.0.0\n', 'utf8');

    expect(() => readReleaseDefinition(filePath)).toThrow(/Invalid release definition/);
    expect(() => readReleaseDefinition(filePath)).toThrow(/release/);
  });

  it('rejects a YAML with missing required "packages" array', () => {
    const filePath = join(tempDir, 'invalid.yaml');
    writeFileSync(filePath, 'release: test-release\n', 'utf8');

    expect(() => readReleaseDefinition(filePath)).toThrow(/Invalid release definition/);
    expect(() => readReleaseDefinition(filePath)).toThrow(/packages/);
  });

  it('provides a descriptive error that is not a raw ZodError', () => {
    const filePath = join(tempDir, 'invalid.yaml');
    writeFileSync(filePath, 'release: 123\npackages: not-an-array\n', 'utf8');

    let error: Error | null = null;
    try {
      readReleaseDefinition(filePath);
    } catch (error_) {
      error = error_ as Error;
    }

    expect(error).not.toBeNull();
    expect(error!.message).toContain('Invalid release definition');
    expect(error!.message).toContain(filePath);
    // Ensure it's a plain Error, not a ZodError with a `issues` property
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((error as any).issues).toBeUndefined();
  });

  it('preserves unknown/extra top-level keys (passthrough)', () => {
    const filePath = join(tempDir, 'with-extra.yaml');
    writeFileSync(
      filePath,
      'release: test\n'
      + 'packages:\n'
      + '  - name: pkg\n'
      + '    version: 1.0.0\n'
      + 'customField: custom-value\n'
      + 'anotherField: 42\n',
      'utf8',
    );

    const read = readReleaseDefinition(filePath);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((read as any).customField).toBe('custom-value');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((read as any).anotherField).toBe(42);
  });

  it('preserves unknown keys inside options (passthrough)', () => {
    const def: ReleaseDefinition = {
      options: {
        customOptionField: 'another-value',
        force: true,
        unlocked: {
          customUnlockedField: 'custom-value',
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
        } as any,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any,
      packages: [{name: 'pkg', version: '1.0.0'}],
      release: 'test',
    };

    const filePath = join(tempDir, 'with-extras.yaml');
    writeReleaseDefinition(filePath, def);
    const read = readReleaseDefinition(filePath);

    expect(read.options?.force).toBe(true);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((read.options as any)?.customOptionField).toBe('another-value');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((read.options?.unlocked as any)?.customUnlockedField).toBe('custom-value');
  });
});

describe('release-definition error handling', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'release-test-'));
  });

  afterEach(() => {
    rmSync(tempDir, {force: true, recursive: true});
  });

  it('throws when reading a nonexistent file', () => {
    const filePath = join(tempDir, 'nonexistent.yaml');
    expect(() => readReleaseDefinition(filePath)).toThrow();
  });

  it('throws when reading invalid YAML syntax', () => {
    const filePath = join(tempDir, 'bad.yaml');
    writeFileSync(filePath, 'release: test\nbad: [unclosed', 'utf8');

    expect(() => readReleaseDefinition(filePath)).toThrow();
  });
});
