import {mkdirSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {
  afterEach, beforeEach, describe, expect, it, vi,
} from 'vitest';

import {resolveConfigPath} from '../../src/project/config-loader.js';
import {defineConfig} from '../../src/types/config.js';

// ============================================================================
// Tests
// ============================================================================

describe('config-loader', () => {
  let testDir: string;

  beforeEach(() => {
    testDir = join(tmpdir(), `sfpm-config-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(testDir, {recursive: true});
  });

  afterEach(() => {
    rmSync(testDir, {force: true, recursive: true});
  });

  // --------------------------------------------------------------------------
  // resolveConfigPath
  // --------------------------------------------------------------------------

  describe('resolveConfigPath', () => {
    it('should return undefined when no config file exists', () => {
      expect(resolveConfigPath(testDir)).toBeUndefined();
    });

    it('should find sfpm.config.ts', () => {
      writeFileSync(join(testDir, 'sfpm.config.ts'), 'export default {}');
      expect(resolveConfigPath(testDir)).toBe(join(testDir, 'sfpm.config.ts'));
    });

    it('should find sfpm.config.js', () => {
      writeFileSync(join(testDir, 'sfpm.config.js'), 'module.exports = {}');
      expect(resolveConfigPath(testDir)).toBe(join(testDir, 'sfpm.config.js'));
    });

    it('should find sfpm.config.mjs', () => {
      writeFileSync(join(testDir, 'sfpm.config.mjs'), 'export default {}');
      expect(resolveConfigPath(testDir)).toBe(join(testDir, 'sfpm.config.mjs'));
    });

    it('should prefer .ts over .js', () => {
      writeFileSync(join(testDir, 'sfpm.config.ts'), 'export default {}');
      writeFileSync(join(testDir, 'sfpm.config.js'), 'module.exports = {}');
      expect(resolveConfigPath(testDir)).toBe(join(testDir, 'sfpm.config.ts'));
    });

    it('should prefer .js over .mjs', () => {
      writeFileSync(join(testDir, 'sfpm.config.js'), 'module.exports = {}');
      writeFileSync(join(testDir, 'sfpm.config.mjs'), 'export default {}');
      expect(resolveConfigPath(testDir)).toBe(join(testDir, 'sfpm.config.js'));
    });
  });

  // --------------------------------------------------------------------------
  // defineConfig
  // --------------------------------------------------------------------------

  describe('defineConfig', () => {
    it('should return the config object as-is (identity function)', () => {
      const config = {hooks: []};
      expect(defineConfig(config)).toBe(config);
    });

    it('should preserve all config properties', () => {
      const config = defineConfig({
        hooks: [],
      });

      expect(config).toEqual({
        hooks: [],
      });
    });
  });

  // --------------------------------------------------------------------------
  // loadSfpmConfig (integration-style with jiti)
  // --------------------------------------------------------------------------

  describe('loadSfpmConfig', () => {
    it('should return default config when no file exists', async () => {
      const {loadSfpmConfig} = await import('../../src/project/config-loader.js');
      const config = await loadSfpmConfig(testDir);

      expect(config).toEqual({});
    });

    it('should load a JS config file', async () => {
      writeFileSync(
        join(testDir, 'sfpm.config.js'),
        'module.exports = { hooks: [] };',
      );

      const {loadSfpmConfig} = await import('../../src/project/config-loader.js');
      const config = await loadSfpmConfig(testDir);

      expect(config).toBeDefined();
      expect(config.hooks).toEqual([]);
    });

    it('should throw on invalid config file', async () => {
      writeFileSync(
        join(testDir, 'sfpm.config.js'),
        'module.exports = "not-an-object";',
      );

      const {loadSfpmConfig} = await import('../../src/project/config-loader.js');
      await expect(loadSfpmConfig(testDir)).rejects.toThrow('must export an object');
    });
  });
});
