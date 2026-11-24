import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync,
} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {
  afterEach, beforeEach, describe, expect, it,
} from 'vitest';

import {WorkspaceProvider} from '../../src/project/providers/workspace-provider.js';
import {WorkspaceInitializer} from '../../src/project/workspace-init.js';
import {WorkspaceSync} from '../../src/project/workspace-sync.js';

// ============================================================================
// Helpers
// ============================================================================

function readTurbo(dir: string): {tasks: Record<string, Record<string, unknown>>} {
  return JSON.parse(readFileSync(path.join(dir, 'turbo.json'), 'utf8'));
}

function writeProject(projectDir: string, sfPackagePath: string): void {
  writeFileSync(path.join(projectDir, 'sfdx-project.json'), JSON.stringify({
    packageDirectories: [{
      default: true,
      package: 'my-package',
      path: sfPackagePath,
      versionNumber: '1.0.0.NEXT',
    }],
    sourceApiVersion: '62.0',
  }, null, 2));
  const classDir = path.join(projectDir, sfPackagePath, 'main/default/classes');
  mkdirSync(classDir, {recursive: true});
  writeFileSync(path.join(classDir, 'Foo.cls'), 'public class Foo {}');
}

describe('WorkspaceInitializer', () => {
  describe('WorkspaceInitializer.scaffold turbo.json', () => {
    let dir: string;

    beforeEach(() => {
      dir = mkdtempSync(path.join(tmpdir(), 'sfpm-init-'));
    });

    afterEach(() => {
      rmSync(dir, {force: true, recursive: true});
    });

    it('generates sfpm:deploy as non-cacheable so Turbo never skips a deploy', async () => {
      await new WorkspaceInitializer().scaffold({npmScope: '@myorg', projectDir: dir});

      const deploy = readTurbo(dir).tasks['sfpm:deploy'];
      expect(deploy.cache).toBe(false);
      expect(deploy.inputs).toBeUndefined();
      expect(deploy.outputs).toBeUndefined();
    });

    it('keeps sfpm:install non-cacheable and sfpm:build cacheable', async () => {
      await new WorkspaceInitializer().scaffold({npmScope: '@myorg', projectDir: dir});

      const {tasks} = readTurbo(dir);
      expect(tasks['sfpm:install'].cache).toBe(false);
      expect(tasks['sfpm:build'].cache).toBe(true);
    });

    it('overwrites an existing cacheable sfpm:deploy and preserves other tasks', async () => {
      writeFileSync(
        path.join(dir, 'turbo.json'),
        JSON.stringify({tasks: {custom: {cache: true}, 'sfpm:deploy': {cache: true, outputs: []}}}),
        'utf8',
      );

      const result = await new WorkspaceInitializer().scaffold({npmScope: '@myorg', projectDir: dir});

      const {tasks} = readTurbo(dir);
      expect(tasks['sfpm:deploy'].cache).toBe(false);
      expect(tasks.custom).toEqual({cache: true});
      expect(result.modified).toContain('turbo.json');
    });
  });

  describe('WorkspaceInitializer.migrate namespace', () => {
    let tmp: string;

    beforeEach(() => {
      tmp = mkdtempSync(path.join(tmpdir(), 'sfpm-migrate-'));
      writeFileSync(path.join(tmp, 'sfdx-project.json'), JSON.stringify({
        namespace: 'myns',
        packageDirectories: [
          {package: 'core', path: 'force-app/core', versionNumber: '1.0.0.NEXT'},
          {package: 'data', path: 'force-app/data', versionNumber: '1.0.0.NEXT'},
        ],
        sourceApiVersion: '63.0',
      }, null, 2));
    });

    afterEach(() => {
      rmSync(tmp, {force: true, recursive: true});
    });

    it('keeps the namespace through migrate and sync for a multi-package project', async () => {
      await new WorkspaceInitializer().migrate({npmScope: '@myorg', projectDir: tmp});

      const corePkg = JSON.parse(readFileSync(path.join(tmp, 'force-app/core/package.json'), 'utf8'));
      expect(corePkg.sfpm.namespace).toBe('myns');

      await new WorkspaceSync({projectDir: tmp}).run();
      const sfdx = JSON.parse(readFileSync(path.join(tmp, 'sfdx-project.json'), 'utf8'));
      expect(sfdx.namespace).toBe('myns');
    });
  });

  describe('scaffold package scripts and gitignore', () => {
    let testDir: string;

    beforeEach(() => {
      testDir = path.join(tmpdir(), `sfpm-workspace-init-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
      mkdirSync(testDir, {recursive: true});
    });

    afterEach(() => {
      rmSync(testDir, {force: true, recursive: true});
    });

    it('points the sfpm:sync script at the real `sfpm project sync` command', async () => {
      await new WorkspaceInitializer().scaffold({npmScope: '@acme', projectDir: testDir});

      const pkg = JSON.parse(readFileSync(path.join(testDir, 'package.json'), 'utf8'));
      expect(pkg.scripts['sfpm:sync']).toBe('sfpm project sync');
    });

    it('writes a .gitignore comment that references `sfpm project sync`', async () => {
      await new WorkspaceInitializer().scaffold({npmScope: '@acme', projectDir: testDir});

      const gitignore = readFileSync(path.join(testDir, '.gitignore'), 'utf8');
      expect(gitignore).toContain('# Generated by sfpm project sync');
      expect(gitignore).not.toMatch(/sfpm sync\b/);
    });

    it('preserves an existing custom sfpm:sync script', async () => {
      writeFileSync(path.join(testDir, 'package.json'), JSON.stringify({scripts: {'sfpm:sync': 'custom'}}));

      await new WorkspaceInitializer().scaffold({npmScope: '@acme', projectDir: testDir});

      const pkg = JSON.parse(readFileSync(path.join(testDir, 'package.json'), 'utf8'));
      expect(pkg.scripts['sfpm:sync']).toBe('custom');
    });
  });

  describe('WorkspaceInitializer.migrate', () => {
    let projectDir: string;
    let initializer: WorkspaceInitializer;

    beforeEach(() => {
      projectDir = mkdtempSync(path.join(tmpdir(), 'sfpm-workspace-init-'));
      initializer = new WorkspaceInitializer();
    });

    afterEach(() => {
      rmSync(projectDir, {force: true, recursive: true});
    });

    it('moves a root source under workspaceDir so the workspace resolves (#95)', async () => {
      writeProject(projectDir, 'force-app');

      const result = await initializer.migrate({npmScope: '@myorg', projectDir, workspaceDir: 'packages'});

      expect(existsSync(path.join(projectDir, 'packages/my-package/force-app/main/default/classes/Foo.cls'))).toBe(true);
      expect(existsSync(path.join(projectDir, 'force-app'))).toBe(false);
      expect(result.modified).toContain('force-app -> packages/my-package/force-app');

      const pkgJson = JSON.parse(readFileSync(path.join(projectDir, 'packages/my-package/package.json'), 'utf8'));
      expect(pkgJson.sfpm.path).toBe('force-app');

      const provider = new WorkspaceProvider({projectDir});
      expect(provider.getPackageDir('my-package')).toBe(path.join(projectDir, 'packages/my-package'));
      expect(provider.getPackageDefinition('my-package')!.path).toBe('packages/my-package/force-app');
    });

    it('keeps sources in place when workspaceDir is not set', async () => {
      writeProject(projectDir, 'force-app');

      const result = await initializer.migrate({npmScope: '@myorg', projectDir});

      expect(existsSync(path.join(projectDir, 'force-app/main/default/classes/Foo.cls'))).toBe(true);
      expect(result.modified.some(entry => entry.includes('->'))).toBe(false);

      const pkgJson = JSON.parse(readFileSync(path.join(projectDir, 'force-app/package.json'), 'utf8'));
      expect(pkgJson.sfpm.path).toBeUndefined();

      const provider = new WorkspaceProvider({projectDir});
      expect(provider.getPackageDir('my-package')).toBe(path.join(projectDir, 'force-app'));
    });

    it('does not move a source already nested under the package dir', async () => {
      writeProject(projectDir, 'packages/my-package/force-app');

      const result = await initializer.migrate({npmScope: '@myorg', projectDir, workspaceDir: 'packages'});

      expect(existsSync(path.join(projectDir, 'packages/my-package/force-app/main/default/classes/Foo.cls'))).toBe(true);
      expect(result.modified.some(entry => entry.includes('->'))).toBe(false);

      const pkgJson = JSON.parse(readFileSync(path.join(projectDir, 'packages/my-package/package.json'), 'utf8'));
      expect(pkgJson.sfpm.path).toBe('force-app');
    });

    it('rejects before writing anything when the destination already exists', async () => {
      writeProject(projectDir, 'force-app');
      mkdirSync(path.join(projectDir, 'packages/my-package/force-app'), {recursive: true});

      await expect(initializer.migrate({npmScope: '@myorg', projectDir, workspaceDir: 'packages'}))
      .rejects.toThrow('destination "packages/my-package/force-app" already exists');

      expect(existsSync(path.join(projectDir, 'turbo.json'))).toBe(false);
      expect(existsSync(path.join(projectDir, 'force-app/main/default/classes/Foo.cls'))).toBe(true);
    });
  });
});
