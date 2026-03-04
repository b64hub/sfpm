import {describe, expect, it} from 'vitest';
import {DirectoryHasher} from '../../src/utils/directory-hasher.js';
import fs from 'fs-extra';
import path from 'path';
import os from 'os';

describe('DirectoryHasher', () => {
  let tmpDir: string;

  async function createTmpDir(): Promise<string> {
    const dir = path.join(os.tmpdir(), `dir-hasher-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    await fs.ensureDir(dir);
    return dir;
  }

  it('should produce a deterministic hash for the same contents', async () => {
    tmpDir = await createTmpDir();
    await fs.writeFile(path.join(tmpDir, 'file1.csv'), 'Id,Name\n001,Account1');
    await fs.writeFile(path.join(tmpDir, 'export.json'), '{"objects":[]}');

    const hash1 = await DirectoryHasher.calculate(tmpDir);
    const hash2 = await DirectoryHasher.calculate(tmpDir);

    expect(hash1).toBe(hash2);
    expect(hash1).toHaveLength(64); // SHA-256 hex

    await fs.remove(tmpDir);
  });

  it('should produce different hashes for different contents', async () => {
    const dir1 = await createTmpDir();
    const dir2 = await createTmpDir();

    await fs.writeFile(path.join(dir1, 'data.csv'), 'Id,Name\n001,Foo');
    await fs.writeFile(path.join(dir2, 'data.csv'), 'Id,Name\n001,Bar');

    const hash1 = await DirectoryHasher.calculate(dir1);
    const hash2 = await DirectoryHasher.calculate(dir2);

    expect(hash1).not.toBe(hash2);

    await fs.remove(dir1);
    await fs.remove(dir2);
  });

  it('should include file paths in hash (structural integrity)', async () => {
    const dir1 = await createTmpDir();
    const dir2 = await createTmpDir();

    // Same content but different filenames
    await fs.writeFile(path.join(dir1, 'a.csv'), 'data');
    await fs.writeFile(path.join(dir2, 'b.csv'), 'data');

    const hash1 = await DirectoryHasher.calculate(dir1);
    const hash2 = await DirectoryHasher.calculate(dir2);

    expect(hash1).not.toBe(hash2);

    await fs.remove(dir1);
    await fs.remove(dir2);
  });

  it('should handle nested directories', async () => {
    tmpDir = await createTmpDir();
    const subDir = path.join(tmpDir, 'subdir');
    await fs.ensureDir(subDir);
    await fs.writeFile(path.join(subDir, 'nested.csv'), 'Id\n001');
    await fs.writeFile(path.join(tmpDir, 'top.csv'), 'Id\n002');

    const hash = await DirectoryHasher.calculate(tmpDir);
    expect(hash).toHaveLength(64);

    await fs.remove(tmpDir);
  });

  it('should produce an empty-ish hash for an empty directory', async () => {
    tmpDir = await createTmpDir();

    const hash = await DirectoryHasher.calculate(tmpDir);
    expect(hash).toHaveLength(64); // SHA-256 of empty input

    await fs.remove(tmpDir);
  });
});
