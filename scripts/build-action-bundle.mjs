#!/usr/bin/env node
/**
 * Builds the committed esbuild bundle for the GitHub Actions
 * (`packages/actions/bundle`).
 *
 *   node scripts/build-action-bundle.mjs
 *
 * Bundles all 8 action entrypoints with esbuild's code-splitting so the
 * shared dependency graph (@salesforce/core, @b64hub/sfpm-core, etc.) is
 * stored once in `bundle/chunks/`, not duplicated per action. Two runtime
 * dependencies can't be inlined and are shipped as real sibling files
 * instead — see the comments below.
 *
 * Assumes `packages/actions/dist` and every workspace dependency's `dist/`
 * are already built (the release workflow runs `pnpm build` first). Does
 * not build or install anything itself.
 */

import {execFileSync} from 'node:child_process';
import {cpSync, existsSync, mkdirSync, readdirSync, rmSync, statSync} from 'node:fs';
import {createRequire} from 'node:module';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const actionsDir = join(repoRoot, 'packages', 'actions');
const coreDir = join(repoRoot, 'packages', 'core');
const bundleDir = join(actionsDir, 'bundle');

const require = createRequire(import.meta.url + '/');

// esbuild is a devDependency of packages/actions, not of the repo root, so
// it must be resolved relative to that package rather than imported directly.
const esbuild = await import(require.resolve('esbuild', {paths: [actionsDir]}));

const ENTRY_POINTS = [
  'src/build-main.ts',
  'src/build-turbo-aggregate-main.ts',
  'src/build-validation-main.ts',
  'src/clean-pool-main.ts',
  'src/deploy-main.ts',
  'src/fill-pool-main.ts',
  'src/install-main.ts',
  'src/validate-main.ts',
];

// Required so bundled CJS deps see a working require()/__dirname/__filename
// under ESM output, and so @salesforce/core's Logger doesn't spawn a pino
// worker-thread transport pointing at a file path that only exists in an
// unbundled install (SF_DISABLE_LOG_FILE routes it through an in-memory
// logger instead — also a sane default for an ephemeral Actions runner).
const banner = [
  "import {createRequire as ___createRequire} from 'node:module';",
  "import {fileURLToPath as ___fileURLToPath} from 'node:url';",
  "import {dirname as ___dirname_fn} from 'node:path';",
  'const require = ___createRequire(import.meta.url);',
  'const __filename = ___fileURLToPath(import.meta.url);',
  'const __dirname = ___dirname_fn(__filename);',
  "process.env.SF_DISABLE_LOG_FILE ??= 'true';",
].join('\n');

/** Copies `src` to `dest`, refusing to touch anything that isn't a real, non-empty directory. */
function safeCopyDir(label, src, dest) {
  if (!existsSync(src) || !statSync(src).isDirectory()) {
    throw new Error(`${label}: resolved path is not a directory: ${src}`);
  }

  if (readdirSync(src).length === 0) {
    throw new Error(`${label}: resolved path is empty, refusing to copy: ${src}`);
  }

  if (src === repoRoot || src === actionsDir) {
    throw new Error(`${label}: resolved path looks wrong (points at the repo/package root): ${src}`);
  }

  cpSync(src, dest, {recursive: true});
}

console.log('Cleaning old bundle...');
rmSync(bundleDir, {recursive: true, force: true});

console.log(`Bundling ${ENTRY_POINTS.length} action entrypoints (code-split, shared chunks)...`);
await esbuild.build({
  bundle: true,
  entryPoints: ENTRY_POINTS,
  format: 'esm',
  splitting: true,
  outdir: bundleDir,
  outExtension: {'.js': '.mjs'},
  platform: 'node',
  target: 'node20',
  // jiti loads a consumer's own sfpm.config.ts at runtime (must stay dynamic
  // — that file doesn't exist at build time) and does its own internal
  // require() relative to its own module file. Inlined, that require
  // resolves against the bundle's directory instead of jiti's real location
  // and breaks. Keeping it external needs a real jiti install alongside the
  // bundle (copied in below).
  external: ['jiti'],
  chunkNames: 'chunks/[name]-[hash]',
  banner: {js: banner},
  absWorkingDir: actionsDir,
  logLevel: 'info',
});

// @salesforce/packaging reads its own message bundles from a `messages/`
// directory on disk at runtime (Messages.importMessagesDirectory), which
// walks up from its own location looking for the nearest package.json. A
// bundled file has no such directory next to it, so ship the real ones.
console.log('Copying @salesforce/packaging package.json + messages/...');
const packagingPkgJson = require.resolve('@salesforce/packaging/package.json', {paths: [actionsDir]});
const packagingDir = dirname(packagingPkgJson);
safeCopyDir('@salesforce/packaging', join(packagingDir, 'messages'), join(bundleDir, 'messages'));
cpSync(packagingPkgJson, join(bundleDir, 'package.json'));

// Real jiti install for the `external: ['jiti']` import above. jiti is a
// dependency of @b64hub/sfpm-core, not of packages/actions directly.
console.log('Copying jiti (external, not inlined)...');
const jitiEntry = require.resolve('jiti', {paths: [coreDir]});
// jitiEntry is .../node_modules/jiti/lib/jiti.cjs — walk up two levels to
// the package root.
const jitiPkgRoot = dirname(dirname(jitiEntry));
mkdirSync(join(bundleDir, 'node_modules'), {recursive: true});
safeCopyDir('jiti', jitiPkgRoot, join(bundleDir, 'node_modules', 'jiti'));

const sizeStr = execFileSync('du', ['-sh', bundleDir], {encoding: 'utf8'}).trim();
console.log(`\nBundle ready: ${sizeStr}`);
