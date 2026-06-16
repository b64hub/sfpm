import fs from 'fs-extra';
import path from 'node:path';

/**
 * Resolve the workspace root for a Salesforce package by walking up from
 * its source path to find the nearest `package.json` with an `sfpm` property.
 *
 * The workspace root is the directory where `package.json` lives — this is
 * where `artifacts/` and other per-package outputs belong.
 *
 * @param projectDirectory - Absolute path to the project root
 * @param sourcePath - Relative path from project root to the package source (e.g. "packages/core/force-app")
 * @returns Absolute path to the package workspace root
 * @throws If no workspace `package.json` with `sfpm` config is found
 */
export function resolvePackageWorkspacePath(projectDirectory: string, sourcePath: string): string {
  const parts = sourcePath.split('/');

  for (let i = parts.length; i > 0; i--) {
    const candidateDir = path.join(projectDirectory, ...parts.slice(0, i));
    const candidatePath = path.join(candidateDir, 'package.json');

    try {
      if (fs.existsSync(candidatePath)) {
        const pkgJson = fs.readJsonSync(candidatePath);
        if (pkgJson.sfpm?.packageType) {
          return candidateDir;
        }
      }
    } catch {
      // Continue searching
    }
  }

  throw new Error(`No workspace package.json with sfpm config found for source path "${sourcePath}" under "${projectDirectory}"`);
}
