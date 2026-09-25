import {existsSync, readdirSync, readFileSync} from 'node:fs';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

import {describe, expect, it} from 'vitest';
import {parse} from 'yaml';

/**
 * Contract tests for the node24 `action.yml` manifests.
 *
 * Inputs arrive as `INPUT_*` automatically, so a renamed input silently reads
 * empty instead of failing loudly — these tests tie each manifest to the code
 * behind it.
 */

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const srcDir = join(packageRoot, 'src');

/** Action name -> compiled entrypoint, read from the dispatcher's fixed map. */
const dispatcherActions = (): Record<string, string> => {
  const source = readFileSync(join(packageRoot, 'bin', 'sfpm-action.mjs'), 'utf8');
  const map = source.match(/const ACTIONS = \{([^}]*)\}/s);
  if (!map) throw new Error('Could not find the ACTIONS map in bin/sfpm-action.mjs');

  return Object.fromEntries(
    [...map[1].matchAll(/'([^']+)':\s*'([^']+)'/g)].map(([, name, file]) => [name, file]),
  );
};

/** Directories holding an action.yml. */
const actionDirs = (): string[] =>
  readdirSync(packageRoot, {withFileTypes: true})
    .filter(e => e.isDirectory() && existsSync(join(packageRoot, e.name, 'action.yml')))
    .map(e => e.name)
    .sort();

/**
 * Source files reachable from an entrypoint via relative imports. Inputs are
 * often read in a helper module rather than the entrypoint itself.
 */
const importGraph = (entrypoint: string): string[] => {
  const seen = new Set<string>();
  const pending = [entrypoint];

  while (pending.length > 0) {
    const file = pending.pop()!;
    if (seen.has(file) || !existsSync(file)) continue;
    seen.add(file);

    for (const [, specifier] of readFileSync(file, 'utf8').matchAll(/from\s+['"](\.[^'"]+)['"]/g)) {
      // tsc emits .js specifiers; the sources next to them are .ts.
      const base = resolve(dirname(file), specifier).replace(/\.js$/, '');
      const candidate = [`${base}.ts`, join(base, 'index.ts')].find(c => existsSync(c));
      if (candidate) pending.push(candidate);
    }
  }

  return [...seen];
};

const namesPassedTo = (files: string[], pattern: RegExp): Set<string> => {
  const found = new Set<string>();
  for (const file of files) {
    for (const [, name] of readFileSync(file, 'utf8').matchAll(pattern)) found.add(name);
  }
  return found;
};

const GET_INPUT = /get(?:Boolean|Multiline)?Input\(\s*['"]([^'"]+)['"]/g;
const SET_OUTPUT = /setOutput\(\s*['"]([^'"]+)['"]/g;

const dirs = actionDirs();
const actions = dispatcherActions();

describe('action manifests', () => {
  it('finds every action directory', () => {
    expect(dirs.length).toBeGreaterThan(0);
  });

  it('has a dispatcher entry for every action directory', () => {
    expect(Object.keys(actions).sort()).toEqual(dirs);
  });

  it.each(dirs)('%s: dispatcher entrypoint exists in src', dir => {
    const entrypoint = join(srcDir, actions[dir].replace(/\.js$/, '.ts'));
    expect(existsSync(entrypoint), `missing ${entrypoint}`).toBe(true);
  });

  describe.each(dirs)('%s', dir => {
    const manifest = parse(readFileSync(join(packageRoot, dir, 'action.yml'), 'utf8'));
    const inputs = Object.keys(manifest.inputs ?? {});
    const outputs = Object.keys(manifest.outputs ?? {});
    const files = importGraph(join(srcDir, (actions[dir] ?? '').replace(/\.js$/, '.ts')));

    it('is a node24 action pointing at its bundled entrypoint', () => {
      expect(manifest.runs.using).toBe('node24');
      const bundleEntry = actions[dir].replace(/\.js$/, '.mjs');
      expect(manifest.runs.main).toBe(`../bundle/${bundleEntry}`);
      expect(manifest.runs.steps).toBeUndefined();
      // No install step left at runtime — the bundle is already committed, unpinned.
      expect(manifest.runs.main).not.toMatch(/\d+\.\d+\.\d+/);
    });

    it('declares outputs without a composite value:', () => {
      for (const name of outputs) expect(manifest.outputs[name].value).toBeUndefined();
    });

    // Catches an input that is declared and forwarded but never actually read
    // (as `validation` was in build/action.yml).
    it('reads every declared input in code', () => {
      const read = namesPassedTo(files, GET_INPUT);
      expect(inputs.filter(name => !read.has(name))).toEqual([]);
    });

    it('produces every declared output in code', () => {
      const written = namesPassedTo(files, SET_OUTPUT);
      expect(outputs.filter(name => !written.has(name))).toEqual([]);
    });

    // Catches an output that is set in code but never declared, so consumers
    // cannot read it (as `cache-age-minutes` was in validate-pr/action.yml).
    it('declares every output it sets in code', () => {
      const written = namesPassedTo(files, SET_OUTPUT);
      expect([...written].filter(name => !outputs.includes(name))).toEqual([]);
    });
  });
});
