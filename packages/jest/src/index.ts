import {findSfpmRoot, ProjectService} from '@b64hub/sfpm-core';
import fs from 'node:fs';
import path from 'node:path';

/** Env var read by `@b64hub/sfpm-jest/resolver` — JSON array of absolute `lwc` directories. */
export const SFPM_JEST_LWC_DIRS_ENV = 'SFPM_JEST_LWC_DIRS';

export interface SetupLwcResolverOptions {
  /**
   * `'lwc'` (default) searches each package's `lwc/` source.
   * `'dist'` searches the package's built `dist/` output instead (see `sfpm build`) —
   * may be stale relative to source if not rebuilt recently.
   */
  mode?: 'dist' | 'lwc';
  /** Package directory to resolve for (self + transitive deps). Defaults to `process.cwd()`. */
  packageDir?: string;
}

/**
 * Computes the `lwc` directories reachable from a package (itself plus its
 * transitive sfpm workspace dependencies) and writes them to
 * `process.env.SFPM_JEST_LWC_DIRS` as a JSON array, for the synchronous
 * `@b64hub/sfpm-jest/resolver` Jest resolver to read.
 *
 * Call once from an async `jest.config.js` before returning the config,
 * since Jest's `resolver` option itself must be synchronous.
 */
export async function setupLwcResolver(options: SetupLwcResolverOptions = {}): Promise<string[]> {
  const packageDir = path.resolve(options.packageDir ?? process.cwd());
  const projectRoot = findSfpmRoot(packageDir) ?? packageDir;

  const service = await ProjectService.create(projectRoot);
  const relPath = path.relative(projectRoot, packageDir).split(path.sep).join('/');
  const self = service.getPackageDefinitionByPath(relPath);
  const deps = service.getProjectGraph().getTransitiveDependencies(self.name);
  const provider = service.getDefinitionProvider();

  const lwcDirs = [self, ...deps].flatMap(pkg => {
    const root = options.mode === 'dist'
      ? provider.getPackageBuiltSourceDirectory(pkg.name)
      : path.join(projectRoot, pkg.path);
    return root ? findLwcDirs(root) : [];
  });

  process.env[SFPM_JEST_LWC_DIRS_ENV] = JSON.stringify(lwcDirs);
  return lwcDirs;
}

/** Recursively finds all directories named `lwc` under `root`. */
function findLwcDirs(root: string): string[] {
  if (!fs.existsSync(root)) return [];

  const found: string[] = [];
  const stack = [root];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, {withFileTypes: true});
    } catch {
      continue;
    }

    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name === 'node_modules') continue;
      const full = path.join(dir, entry.name);
      if (entry.name === 'lwc') found.push(full);
      else stack.push(full);
    }
  }

  return found;
}
