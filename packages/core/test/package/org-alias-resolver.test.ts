import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import fs from 'fs-extra';
import os from 'node:os';
import path from 'node:path';

import {OrgAliasResolver, ORG_ALIAS_DEFAULT_DIR} from '../../src/package/org-alias-resolver.js';

describe('OrgAliasResolver', () => {
  let tmpDir: string;
  let packagePath: string;
  let mockLogger: any;

  beforeEach(async () => {
    tmpDir = path.join(os.tmpdir(), `org-alias-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    packagePath = path.join(tmpDir, 'my-package');
    await fs.ensureDir(packagePath);

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

  async function setupDefaultDir(files: Record<string, string> = {}): Promise<void> {
    const defaultDir = path.join(packagePath, ORG_ALIAS_DEFAULT_DIR);
    await fs.ensureDir(defaultDir);
    for (const [filePath, content] of Object.entries(files)) {
      const fullPath = path.join(defaultDir, filePath);
      await fs.ensureDir(path.dirname(fullPath));
      await fs.writeFile(fullPath, content);
    }
  }

  async function setupOrgDir(orgName: string, files: Record<string, string> = {}): Promise<void> {
    const orgDir = path.join(packagePath, orgName);
    await fs.ensureDir(orgDir);
    for (const [filePath, content] of Object.entries(files)) {
      const fullPath = path.join(orgDir, filePath);
      await fs.ensureDir(path.dirname(fullPath));
      await fs.writeFile(fullPath, content);
    }
  }

  describe('resolve', () => {
    it('should throw when default directory is missing', async () => {
      const resolver = new OrgAliasResolver(mockLogger);

      await expect(resolver.resolve(packagePath, 'uat', true))
        .rejects.toThrow(`Org-aliased package is missing required '${ORG_ALIAS_DEFAULT_DIR}/' directory`);
    });

    it('should fall back to default when no org directory matches', async () => {
      await setupDefaultDir({'classes/MyClass.cls': 'default content'});

      const resolver = new OrgAliasResolver(mockLogger);
      const result = await resolver.resolve(packagePath, 'nonexistent-org', true);

      expect(result.matched).toBe(false);
      expect(result.resolvedAlias).toBe(ORG_ALIAS_DEFAULT_DIR);
      expect(result.effectivePath).toBe(path.join(packagePath, ORG_ALIAS_DEFAULT_DIR));
    });

    it('should use org directory in disjoint mode', async () => {
      await setupDefaultDir({'classes/DefaultClass.cls': 'default class'});
      await setupOrgDir('uat', {'classes/UatClass.cls': 'uat class'});

      const resolver = new OrgAliasResolver(mockLogger);
      const result = await resolver.resolve(packagePath, 'uat', {mode: 'disjoint'});

      expect(result.matched).toBe(true);
      expect(result.resolvedAlias).toBe('uat');
      expect(result.effectivePath).toBe(path.join(packagePath, 'uat'));

      // Only org files should be accessible
      expect(await fs.pathExists(path.join(result.effectivePath, 'classes', 'UatClass.cls'))).toBe(true);
      expect(await fs.pathExists(path.join(result.effectivePath, 'classes', 'DefaultClass.cls'))).toBe(false);
    });

    it('should merge default + org in union mode (default mode)', async () => {
      await setupDefaultDir({
        'classes/DefaultClass.cls': 'default class',
        'classes/SharedClass.cls': 'default shared',
        'objects/Account.object-meta.xml': '<object/>',
      });
      await setupOrgDir('uat', {
        'classes/UatClass.cls': 'uat only',
        'classes/SharedClass.cls': 'uat override',
      });

      const resolver = new OrgAliasResolver(mockLogger);
      const result = await resolver.resolve(packagePath, 'uat', true);

      expect(result.matched).toBe(true);
      expect(result.resolvedAlias).toBe('uat');

      // Union: default files + org overrides
      const mergedDir = result.effectivePath;
      expect(await fs.readFile(path.join(mergedDir, 'classes', 'DefaultClass.cls'), 'utf8')).toBe('default class');
      expect(await fs.readFile(path.join(mergedDir, 'classes', 'UatClass.cls'), 'utf8')).toBe('uat only');
      // Org overrides default for shared files
      expect(await fs.readFile(path.join(mergedDir, 'classes', 'SharedClass.cls'), 'utf8')).toBe('uat override');
      // Default-only files are preserved
      expect(await fs.readFile(path.join(mergedDir, 'objects', 'Account.object-meta.xml'), 'utf8')).toBe('<object/>');
    });

    it('should use union mode when config is boolean true', async () => {
      await setupDefaultDir({'classes/Base.cls': 'base'});
      await setupOrgDir('prod', {'classes/Prod.cls': 'prod'});

      const resolver = new OrgAliasResolver(mockLogger);
      const result = await resolver.resolve(packagePath, 'prod', true);

      expect(result.matched).toBe(true);
      // Both files should be in merged output
      expect(await fs.pathExists(path.join(result.effectivePath, 'classes', 'Base.cls'))).toBe(true);
      expect(await fs.pathExists(path.join(result.effectivePath, 'classes', 'Prod.cls'))).toBe(true);
    });

    it('should use union mode when config object has no mode specified', async () => {
      await setupDefaultDir({'classes/Base.cls': 'base'});
      await setupOrgDir('staging', {'classes/Staging.cls': 'staging'});

      const resolver = new OrgAliasResolver(mockLogger);
      const result = await resolver.resolve(packagePath, 'staging', {});

      expect(result.matched).toBe(true);
      expect(await fs.pathExists(path.join(result.effectivePath, 'classes', 'Base.cls'))).toBe(true);
      expect(await fs.pathExists(path.join(result.effectivePath, 'classes', 'Staging.cls'))).toBe(true);
    });
  });

  describe('getAvailableAliases', () => {
    it('should list org directories excluding default', async () => {
      await setupDefaultDir();
      await setupOrgDir('uat', {});
      await setupOrgDir('prod', {});
      await setupOrgDir('staging', {});

      const resolver = new OrgAliasResolver(mockLogger);
      const aliases = await resolver.getAvailableAliases(packagePath);

      expect(aliases).toContain('uat');
      expect(aliases).toContain('prod');
      expect(aliases).toContain('staging');
      expect(aliases).not.toContain(ORG_ALIAS_DEFAULT_DIR);
    });

    it('should return empty array for non-existent path', async () => {
      const resolver = new OrgAliasResolver(mockLogger);
      const aliases = await resolver.getAvailableAliases('/nonexistent/path');

      expect(aliases).toEqual([]);
    });
  });
});
