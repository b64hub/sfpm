import {
  existsSync, mkdirSync, rmSync, writeFileSync,
} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {
  afterEach, beforeEach, describe, expect, it,
} from 'vitest';

import {WorkspaceProvider} from '../../../src/project/providers/workspace-provider.js';
import {WorkspaceSync} from '../../../src/project/workspace-sync.js';

// ============================================================================
// Tests
// ============================================================================

describe('WorkspaceProvider', () => {
  let projectDir: string;

  beforeEach(() => {
    projectDir = join(tmpdir(), `sfpm-ws-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(projectDir, {recursive: true});
  });

  afterEach(() => {
    rmSync(projectDir, {force: true, recursive: true});
  });

  const writePnpmWorkspace = (globs: string[]) => {
    writeFileSync(join(projectDir, 'pnpm-workspace.yaml'), `packages:\n${globs.map(g => `  - '${g}'`).join('\n')}\n`);
  };

  describe('empty workspace', () => {
    beforeEach(() => {
      writePnpmWorkspace(['packages/*']);
    });

    it('resolves to zero packages with a warning and writes no sfdx-project.json', () => {
      const provider = new WorkspaceProvider({projectDir});
      const result = provider.resolve();

      expect(result.definition.packages).toEqual([]);
      expect(result.warnings.some(w => w.includes('No workspace packages'))).toBe(true);
      expect(provider.getAllPackageNames()).toEqual([]);
      expect(existsSync(join(projectDir, 'sfdx-project.json'))).toBe(false);
    });

    it('WorkspaceSync.run() succeeds with no packages and writes no sfdx-project.json', async () => {
      const result = await new WorkspaceSync({projectDir}).run();

      expect(result.packages).toEqual([]);
      expect(result.warnings.length).toBeGreaterThan(0);
      expect(existsSync(join(projectDir, 'sfdx-project.json'))).toBe(false);
    });
  });

  describe('one package', () => {
    it('resolves the package and writes sfdx-project.json', () => {
      writePnpmWorkspace(['packages/*']);
      mkdirSync(join(projectDir, 'packages', 'a'), {recursive: true});
      writeFileSync(join(projectDir, 'packages', 'a', 'package.json'), JSON.stringify({
        name: '@x/a',
        sfpm: {packageType: 'source'},
        version: '1.0.0',
      }));

      const provider = new WorkspaceProvider({projectDir});
      const result = provider.resolve();

      expect(result.definition.packages).toHaveLength(1);
      expect(provider.getAllPackageNames()).toEqual(['@x/a']);
      expect(existsSync(join(projectDir, 'sfdx-project.json'))).toBe(true);
    });
  });

  describe('getPackagesDir', () => {
    it('returns the base of a wildcard glob', () => {
      writePnpmWorkspace(['packages/*']);
      expect(new WorkspaceProvider({projectDir}).getPackagesDir()).toBe('packages');
    });

    it('returns the base of a recursive wildcard glob', () => {
      writePnpmWorkspace(['src/**']);
      expect(new WorkspaceProvider({projectDir}).getPackagesDir()).toBe('src');
    });

    it('returns undefined when only exact globs exist', () => {
      writePnpmWorkspace(['force-app']);
      expect(new WorkspaceProvider({projectDir}).getPackagesDir()).toBeUndefined();
    });

    it('reads npm root package.json workspaces', () => {
      writeFileSync(join(projectDir, 'package.json'), JSON.stringify({name: 'root', workspaces: ['apps/*']}));
      expect(new WorkspaceProvider({projectDir}).getPackagesDir()).toBe('apps');
    });
  });
});
