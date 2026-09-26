import {
  existsSync, readdirSync, readFileSync, statSync,
} from 'node:fs';
/**
 * Shared discovery of GitHub Action manifests (`action.yml`) and their bundle
 * entry points.
 *
 * The build script and the smoke test both need the same list of actions,
 * derived the same way: previously each parsed `action.yml` itself (one via
 * `import`, one via `require`) with slightly different validation, which
 * would drift apart over time. This module is the one source of truth.
 */
import {createRequire} from 'node:module';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';

const require = createRequire(import.meta.url);

export const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const actionsDir = join(repoRoot, 'packages', 'actions');
export const bundleDir = join(actionsDir, 'bundle');
export const metafilePath = join(actionsDir, 'bundle-metafile.json');

// Every action.yml in this repo is expected to point runs.main at its own
// bundle entry: `../bundle/<name>.mjs`, built from `src/<name>.ts`. Anything
// else is a manifest that was hand-edited out of sync with the build.
const MAIN_PATTERN = /^\.\.\/bundle\/(.+)\.mjs$/;

let yamlModulePromise;

/** `yaml` is a devDependency of packages/actions, not of the repo root, so it must be resolved (and loaded) relative to that package. */
function loadYaml() {
  yamlModulePromise ??= import(pathToFileURL(require.resolve('yaml', {paths: [actionsDir]})).href);
  return yamlModulePromise;
}

/**
 * Discover every `packages/actions/<name>/action.yml`, parse it, and derive
 * the bundle entry file and esbuild source entry from `runs.main`.
 *
 * Returns `[{name, dir, manifest, main, bundleFile, sourceEntry}]` sorted by
 * action directory name, so build and smoke-test output order is stable.
 *
 * Throws if a manifest is missing `runs.main`, or `runs.main` doesn't match
 * the `../bundle/<name>.mjs` convention — either means the manifest and the
 * build have already drifted apart, which both callers need to fail loudly
 * on rather than silently skip.
 */
export async function listActions() {
  const {parse} = await loadYaml();

  const dirNames = readdirSync(actionsDir)
  .filter(name => {
    const full = join(actionsDir, name);
    return statSync(full).isDirectory() && existsSync(join(full, 'action.yml'));
  })
  .sort();

  return dirNames.map(name => {
    const dir = join(actionsDir, name);
    const manifestPath = join(dir, 'action.yml');
    const manifest = parse(readFileSync(manifestPath, 'utf8'));
    const main = manifest?.runs?.main;

    if (!main) {
      throw new Error(`${manifestPath}: missing runs.main`);
    }

    const match = main.match(MAIN_PATTERN);
    if (!match) {
      throw new Error(`${manifestPath}: runs.main "${main}" does not match the expected "../bundle/<name>.mjs" format`);
    }

    const entryName = match[1];
    return {
      bundleFile: `${entryName}.mjs`,
      dir,
      main,
      manifest,
      name,
      sourceEntry: `src/${entryName}.ts`,
    };
  });
}
