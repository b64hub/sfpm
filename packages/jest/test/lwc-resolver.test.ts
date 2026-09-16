import {createRequire} from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  afterEach, beforeEach, describe, expect, it,
} from 'vitest';

import {ProjectService} from '@b64hub/sfpm-core';

import {setupLwcResolver, SFPM_JEST_LWC_DIRS_ENV} from '../src/index.js';

const require = createRequire(import.meta.url);
const resolver = require('../dist/resolver.cjs') as (modulePath: string, options: {extensions: string[]}) => string;

// ============================================================================
// Fixture: a 2-package workspace where pkg-a depends on pkg-b, and pkg-b
// owns a `c/foo` LWC component.
// ============================================================================

function writeJson(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), {recursive: true});
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2));
}

function createFixtureWorkspace(): {pkgADir: string; pkgBLwcDir: string; root: string} {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'sfpm-jest-fixture-'));

  fs.writeFileSync(path.join(root, 'pnpm-workspace.yaml'), "packages:\n  - 'packages/*'\n");
  fs.writeFileSync(path.join(root, 'sfpm.config.js'), 'module.exports = {};\n');

  const pkgADir = path.join(root, 'packages', 'pkg-a');
  writeJson(path.join(pkgADir, 'package.json'), {
    dependencies: {'@fixture/pkg-b': 'workspace:*'},
    name: '@fixture/pkg-a',
    sfpm: {packageType: 'unlocked'},
    version: '1.0.0',
  });

  const pkgBDir = path.join(root, 'packages', 'pkg-b');
  writeJson(path.join(pkgBDir, 'package.json'), {
    name: '@fixture/pkg-b',
    sfpm: {packageType: 'unlocked'},
    version: '1.0.0',
  });

  const pkgBLwcDir = path.join(pkgBDir, 'lwc');
  fs.mkdirSync(path.join(pkgBLwcDir, 'foo'), {recursive: true});
  fs.writeFileSync(path.join(pkgBLwcDir, 'foo', 'foo.js'), 'export default class Foo {}\n');

  return {pkgADir, pkgBLwcDir, root};
}

describe('setupLwcResolver + @b64hub/sfpm-jest/resolver', () => {
  let fixture: ReturnType<typeof createFixtureWorkspace>;

  beforeEach(() => {
    fixture = createFixtureWorkspace();
    ProjectService.resetInstance();
  });

  afterEach(() => {
    fs.rmSync(fixture.root, {force: true, recursive: true});
    delete process.env[SFPM_JEST_LWC_DIRS_ENV];
  });

  it('computes lwc dirs for the package plus its transitive workspace deps', async () => {
    const dirs = await setupLwcResolver({packageDir: fixture.pkgADir});

    // pkg-a has no lwc/ dir of its own in this fixture — only pkg-b's is found.
    expect(dirs).toHaveLength(1);
    expect(fs.realpathSync(dirs[0])).toBe(fs.realpathSync(fixture.pkgBLwcDir));
  });

  it('writes the computed dirs to process.env.SFPM_JEST_LWC_DIRS as JSON', async () => {
    const dirs = await setupLwcResolver({packageDir: fixture.pkgADir});

    expect(JSON.parse(process.env[SFPM_JEST_LWC_DIRS_ENV] ?? '[]')).toEqual(dirs);
  });

  it('resolver.cjs resolves a c/* component owned by a transitive dependency', async () => {
    await setupLwcResolver({packageDir: fixture.pkgADir});

    const resolved = resolver('c/foo', {extensions: ['.js']});
    expect(fs.realpathSync(resolved)).toBe(fs.realpathSync(path.join(fixture.pkgBLwcDir, 'foo', 'foo.js')));
  });

  it('resolver.cjs maps the bare `lwc` specifier to @lwc/engine-dom', () => {
    expect(resolver('lwc', {extensions: ['.js']})).toBe(require.resolve('@lwc/engine-dom'));
  });

  it('resolver.cjs uses dist mode to resolve against built output instead of source', async () => {
    const pkgBDistLwcDir = path.join(fixture.root, 'packages', 'pkg-b', 'dist', 'lwc');
    fs.mkdirSync(path.join(pkgBDistLwcDir, 'foo'), {recursive: true});
    fs.writeFileSync(path.join(pkgBDistLwcDir, 'foo', 'foo.js'), 'export default class Foo {}\n');

    const dirs = await setupLwcResolver({mode: 'dist', packageDir: fixture.pkgADir});
    expect(dirs).toHaveLength(1);
    expect(fs.realpathSync(dirs[0])).toBe(fs.realpathSync(pkgBDistLwcDir));

    const resolved = resolver('c/foo', {extensions: ['.js']});
    expect(fs.realpathSync(resolved)).toBe(fs.realpathSync(path.join(pkgBDistLwcDir, 'foo', 'foo.js')));
  });
});
