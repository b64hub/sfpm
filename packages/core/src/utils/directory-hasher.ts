import fg from 'fast-glob';
import fs from 'fs-extra';
import crypto from 'node:crypto';
import path from 'node:path';

/**
 * Content-agnostic directory hasher.
 *
 * Recursively hashes all files in a directory to produce a deterministic
 * SHA-256 digest. Files are sorted by relative path before hashing to
 * guarantee consistent ordering across runs and platforms.
 *
 * Used by data packages (and any other non-metadata package types) where
 * a ComponentSet-based hash is not applicable.
 */
export class DirectoryHasher {
  /**
   * Calculate a deterministic SHA-256 hash of all files in a directory.
   *
   * @param directory - Absolute path to the directory to hash
   * @returns Hex-encoded SHA-256 digest
   */
  public static async calculate(directory: string): Promise<string> {
    const hash = crypto.createHash('sha256');

    // Enumerate all files, sorted for determinism
    const files = await fg(['**/*'], {
      cwd: directory,
      dot: false,
      onlyFiles: true,
    });
    files.sort();

    for (const relativePath of files) {
      // Include the relative path in the hash for structural integrity
      hash.update(relativePath);

      const absolutePath = path.join(directory, relativePath);
      // eslint-disable-next-line no-await-in-loop -- sequential read required for deterministic hash ordering
      const content = await fs.readFile(absolutePath);
      hash.update(content);
    }

    return hash.digest('hex');
  }
}
