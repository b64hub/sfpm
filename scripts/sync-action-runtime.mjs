#!/usr/bin/env node
/**
 * Manages the pinned runtime shared by the composite actions
 * (`packages/actions/runtime`).
 *
 *   node scripts/sync-action-runtime.mjs --check
 *     Verify the committed lockfile pins exactly the version the runtime
 *     manifest asks for. No network. Runs in PR CI.
 *
 *   node scripts/sync-action-runtime.mjs [--version X.Y.Z]
 *     Point the runtime at a published version and regenerate the lockfile.
 *     Defaults to the version of packages/actions/package.json. Requires the
 *     version to already be on the registry, so release runs this *after*
 *     publishing.
 *
 * The runtime version deliberately trails `packages/actions/package.json`
 * between releases: it can only pin something already published.
 */

import {execFileSync} from 'node:child_process';
import {readFileSync, writeFileSync} from 'node:fs';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';

const PACKAGE = '@b64hub/sfpm-actions';
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const runtimeDir = join(repoRoot, 'packages', 'actions', 'runtime');
const manifestPath = join(runtimeDir, 'package.json');
const lockPath = join(runtimeDir, 'package-lock.json');

const readJson = path => JSON.parse(readFileSync(path, 'utf8'));

const lockedVersion = () => {
  const lock = readJson(lockPath);
  return lock.packages?.[`node_modules/${PACKAGE}`]?.version;
};

if (process.argv.includes('--check')) {
  const wanted = readJson(manifestPath).dependencies[PACKAGE];
  const locked = lockedVersion();

  console.log(`runtime manifest wants: ${PACKAGE}@${wanted}`);
  console.log(`lockfile pins:          ${PACKAGE}@${locked}`);

  if (wanted !== locked) {
    console.error(`\nLockfile is out of sync with the runtime manifest.`);
    console.error(`Run: node scripts/sync-action-runtime.mjs --version ${wanted}`);
    process.exit(1);
  }

  const lock = readJson(lockPath);
  const total = Object.keys(lock.packages).length - 1;
  const withIntegrity = Object.values(lock.packages).filter(p => p.integrity).length;
  console.log(`pinned packages:        ${total} (${withIntegrity} with integrity hashes)`);
  console.log('Runtime lockfile is in sync.');
  process.exit(0);
}

const versionFlag = process.argv.indexOf('--version');
const version = versionFlag === -1
  ? readJson(join(repoRoot, 'packages', 'actions', 'package.json')).version
  : process.argv[versionFlag + 1];

if (!version) {
  console.error('--version requires a value');
  process.exit(1);
}

const manifest = readJson(manifestPath);
manifest.dependencies[PACKAGE] = version;
writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`Pinned ${PACKAGE}@${version}, regenerating lockfile...`);

// --package-lock-only: resolve and write the tree without installing it.
execFileSync('npm', ['install', '--package-lock-only', '--ignore-scripts'], {
  cwd: runtimeDir,
  stdio: 'inherit',
});

const locked = lockedVersion();
if (locked !== version) {
  console.error(`Lockfile pinned ${locked}, expected ${version}. Is ${PACKAGE}@${version} published?`);
  process.exit(1);
}

console.log(`Lockfile regenerated: ${PACKAGE}@${locked}`);
