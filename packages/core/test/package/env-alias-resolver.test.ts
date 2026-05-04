import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import fs from 'fs-extra';
import os from 'node:os';
import path from 'node:path';

import {EnvAliasResolver, ENV_ALIAS_DEFAULT_DIR} from '../../src/package/env-alias-resolver.js';

describe('EnvAliasResolver', () => {
  let tmpDir: string;
  let packagePath: string;
  let mockLogger: any;

  beforeEach(async () => {
    tmpDir = path.join(os.tmpdir(), `env-alias-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    packagePath = path.join(tmpDir, 'my-package');
    await fs.ensureDir(packagePath);

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

  async function setupDefaultDir(files: Record<string, string> = {}): Promise<void> {
    const defaultDir = path.join(packagePath, ENV_ALIAS_DEFAULT_DIR);
    await fs.ensureDir(defaultDir);
    for (const [filePath, content] of Object.entries(files)) {
      const fullPath = path.join(defaultDir, filePath);
      await fs.ensureDir(path.dirname(fullPath));
      await fs.writeFile(fullPath, content);
    }
  }

  async function setupEnvDir(envName: string, files: Record<string, string> = {}): Promise<void> {
    const envDir = path.join(packagePath, envName);
    await fs.ensureDir(envDir);
    for (const [filePath, content] of Object.entries(files)) {
      const fullPath = path.join(envDir, filePath);
      await fs.ensureDir(path.dirname(fullPath));
      await fs.writeFile(fullPath, content);
    }
  }

  describe('resolve', () => {
    it('should throw when default directory is missing', async () => {
      const resolver = new EnvAliasResolver(mockLogger);

      await expect(resolver.resolve(packagePath, 'uat', true))
        .rejects.toThrow(`Env-aliased package is missing required '${ENV_ALIAS_DEFAULT_DIR}/' directory`);
    });

    it('should fall back to default when no env directory matches', async () => {
      await setupDefaultDir({'classes/MyClass.cls': 'default content'});

      const resolver = new EnvAliasResolver(mockLogger);
      const result = await resolver.resolve(packagePath, 'nonexistent-org', true);

      expect(result.matched).toBe(false);
      expect(result.resolvedAlias).toBe(ENV_ALIAS_DEFAULT_DIR);
      expect(result.effectivePath).toBe(path.join(packagePath, ENV_ALIAS_DEFAULT_DIR));
    });

    it('should use env directory in disjoint mode', async () => {
      await setupDefaultDir({'classes/DefaultClass.cls': 'default class'});
      await setupEnvDir('uat', {'classes/UatClass.cls': 'uat class'});

      const resolver = new EnvAliasResolver(mockLogger);
      const result = await resolver.resolve(packagePath, 'uat', {mode: 'disjoint'});

      expect(result.matched).toBe(true);
      expect(result.resolvedAlias).toBe('uat');
      expect(result.effectivePath).toBe(path.join(packagePath, 'uat'));

      // Only env files should be accessible
      expect(await fs.pathExists(path.join(result.effectivePath, 'classes', 'UatClass.cls'))).toBe(true);
      expect(await fs.pathExists(path.join(result.effectivePath, 'classes', 'DefaultClass.cls'))).toBe(false);
    });

    it('should merge default + env in union mode (default mode)', async () => {
      await setupDefaultDir({
        'classes/DefaultClass.cls': 'default class',
        'classes/SharedClass.cls': 'default shared',
        'objects/Account.object-meta.xml': '<object/>',
      });
      await setupEnvDir('uat', {
        'classes/UatClass.cls': 'uat only',
        'classes/SharedClass.cls': 'uat override',
      });

      const resolver = new EnvAliasResolver(mockLogger);
      const result = await resolver.resolve(packagePath, 'uat', true);

      expect(result.matched).toBe(true);
      expect(result.resolvedAlias).toBe('uat');

      // Union: default files + env overrides
      const mergedDir = result.effectivePath;
      expect(await fs.readFile(path.join(mergedDir, 'classes', 'DefaultClass.cls'), 'utf8')).toBe('default class');
      expect(await fs.readFile(path.join(mergedDir, 'classes', 'UatClass.cls'), 'utf8')).toBe('uat only');
      // Env overrides default for shared files
      expect(await fs.readFile(path.join(mergedDir, 'classes', 'SharedClass.cls'), 'utf8')).toBe('uat override');
      // Default-only files are preserved
      expect(await fs.readFile(path.join(mergedDir, 'objects', 'Account.object-meta.xml'), 'utf8')).toBe('<object/>');
    });

    it('should use union mode when config is boolean true', async () => {
      await setupDefaultDir({'classes/Base.cls': 'base'});
      await setupEnvDir('prod', {'classes/Prod.cls': 'prod'});

      const resolver = new EnvAliasResolver(mockLogger);
      const result = await resolver.resolve(packagePath, 'prod', true);

      expect(result.matched).toBe(true);
      // Both files should be in merged output
      expect(await fs.pathExists(path.join(result.effectivePath, 'classes', 'Base.cls'))).toBe(true);
      expect(await fs.pathExists(path.join(result.effectivePath, 'classes', 'Prod.cls'))).toBe(true);
    });

    it('should use union mode when config object has no mode specified', async () => {
      await setupDefaultDir({'classes/Base.cls': 'base'});
      await setupEnvDir('staging', {'classes/Staging.cls': 'staging'});

      const resolver = new EnvAliasResolver(mockLogger);
      const result = await resolver.resolve(packagePath, 'staging', {});

      expect(result.matched).toBe(true);
      expect(await fs.pathExists(path.join(result.effectivePath, 'classes', 'Base.cls'))).toBe(true);
      expect(await fs.pathExists(path.join(result.effectivePath, 'classes', 'Staging.cls'))).toBe(true);
    });
  });

  describe('getAvailableAliases', () => {
    it('should list env directories excluding default', async () => {
      await setupDefaultDir();
      await setupEnvDir('uat', {});
      await setupEnvDir('prod', {});
      await setupEnvDir('staging', {});

      const resolver = new EnvAliasResolver(mockLogger);
      const aliases = await resolver.getAvailableAliases(packagePath);

      expect(aliases).toContain('uat');
      expect(aliases).toContain('prod');
      expect(aliases).toContain('staging');
      expect(aliases).not.toContain(ENV_ALIAS_DEFAULT_DIR);
    });

    it('should return empty array for non-existent path', async () => {
      const resolver = new EnvAliasResolver(mockLogger);
      const aliases = await resolver.getAvailableAliases('/nonexistent/path');

      expect(aliases).toEqual([]);
    });
  });
});
