#!/usr/bin/env node
/**
 * Builds the esbuild bundle for the GitHub Actions (`packages/actions/bundle`).
 * The bundle is built only at release time and added only to the commit a
 * release tag points to (never to `main`) by `.github/workflows/release.yml`.
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

import {cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {dirname, join, resolve} from 'node:path';
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

/**
 * Required so bundled CJS deps see a working require()/__dirname/__filename
 * under ESM output, and so @salesforce/core's Logger doesn't spawn a pino
 * worker-thread transport pointing at a file path that only exists in an
 * unbundled install (SF_DISABLE_LOG_FILE routes it through an in-memory
 * logger instead — also a sane default for an ephemeral Actions runner).
 *
 * RISKS (guarded by smoke test scripts/smoke-test-action-bundle.mjs):
 * (a) A bundled ESM module that declares a top-level `const __dirname` will fail
 *     to load with an 'already declared' error (name collision).
 * (b) Inlined CommonJS dependencies that read `__dirname` at their own top level
 *     now see the OUTPUT file's directory (bundle/ or bundle/chunks/), not their
 *     original package directory. Any file read relative to __dirname inside an
 *     inlined dependency resolves to the wrong place. This breaks packaging's
 *     Messages.importMessagesDirectory(__dirname) — solution: ship the actual
 *     messages/ directory alongside the bundle (done below) so relative path
 *     traversal works. Both risks require the smoke test to catch them.
 */
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
const buildResult = await esbuild.build({
  bundle: true,
  entryPoints: ENTRY_POINTS,
  format: 'esm',
  splitting: true,
  outdir: bundleDir,
  outExtension: {'.js': '.mjs'},
  platform: 'node',
  target: 'node24',
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
  metafile: true,
});

/**
 * Check that exactly one version of @salesforce/packaging is bundled.
 *
 * Only @salesforce/packaging genuinely reads message bundles from disk at runtime
 * (via Messages.importMessagesDirectory(__dirname) at top-level call sites in its
 * own compiled lib/*.js files). Other Salesforce libraries (@salesforce/core,
 * @salesforce/source-deploy-retrieve, @salesforce/apex-node) have their messages
 * pre-inlined as literal Map(...) at their own publish time and do not read from
 * disk at runtime. This single-package design is correct and sufficient as long as
 * the checked-in smoke test (scripts/smoke-test-action-bundle.mjs) keeps confirming
 * no second library also needs messages shipped.
 *
 * If esbuild ever bundles two distinct versions of @salesforce/packaging (e.g. a
 * transitive dependency at a different version), the shipped messages/ directory
 * won't match one of them and message loading will fail. This check fails loudly
 * and early rather than allowing the build to silently produce broken bundles.
 *
 * If a second library ever DOES need messages shipped, the fix is an esbuild
 * plugin rewriting each library's Messages.importMessagesDirectory call to its own
 * bundle/messages/<package>/ subdirectory, not attempted here since it isn't needed
 * today.
 */
if (buildResult.metafile && buildResult.metafile.inputs) {
  const packagingVersions = new Set();
  for (const inputPath of Object.keys(buildResult.metafile.inputs)) {
    // Metafile inputs are typically like:
    // node_modules/.pnpm/@salesforce+packaging@4.18.12_.../node_modules/@salesforce/packaging/lib/...
    // Extract the version from the path.
    const match = inputPath.match(/\/@salesforce\+packaging@([^/]+)/);
    if (match) packagingVersions.add(match[1]);
  }

  if (packagingVersions.size > 1) {
    throw new Error(
      `Bundled code includes ${packagingVersions.size} distinct versions of @salesforce/packaging: ${Array.from(packagingVersions).join(', ')}. ` +
      `The shipped messages/ directory won't match all of them. ` +
      `If two versions are truly needed, implement per-library message subdirectories via an esbuild plugin.`
    );
  }
}

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

// Defensive assertion: verify we found a real jiti package, not something else,
// and that its version matches what pnpm actually resolved.
const jitiPkgJsonPath = join(jitiPkgRoot, 'package.json');
if (!existsSync(jitiPkgJsonPath)) {
  throw new Error(`jiti package.json not found at expected location: ${jitiPkgJsonPath}`);
}

const jitiPkgJson = JSON.parse(readFileSync(jitiPkgJsonPath, 'utf8'));
if (jitiPkgJson.name !== 'jiti') {
  throw new Error(`Found package at ${jitiPkgRoot} with name '${jitiPkgJson.name}', not 'jiti'. Path lookup may be broken.`);
}

// Check that the jiti version copied matches the one pnpm resolved in pnpm-lock.yaml.
// Read the lockfile and find all jiti entries (which may have peer-dep suffixes).
const lockfilePath = join(repoRoot, 'pnpm-lock.yaml');
if (!existsSync(lockfilePath)) {
  throw new Error(`pnpm-lock.yaml not found at ${lockfilePath}`);
}

const lockfileContent = readFileSync(lockfilePath, 'utf8');
// Match jiti@<version>: at the start of a line (top-level package entries in YAML).
// This avoids false positives from jiti@X references inside peer-dep suffixes on other packages.
const jitiVersionMatches = lockfileContent.match(/^  jiti@([^:(]+):/gm);
if (!jitiVersionMatches) {
  throw new Error(`No jiti entry found in pnpm-lock.yaml`);
}

const jitiVersionsInLock = new Set(
  jitiVersionMatches.map(m => m.match(/jiti@([^:(]+):/)[1])
);

// Verify that the jiti version we're bundling is resolvable from the lock.
// Multiple versions may exist in the lock (transitive deps), but we must bundle one
// that's actually in the lock, and preferably the one @b64hub/sfpm-core depends on.
if (!jitiVersionsInLock.has(jitiPkgJson.version)) {
  throw new Error(
    `jiti version ${jitiPkgJson.version} (from copied package.json) not found in pnpm-lock.yaml. ` +
    `Available versions: ${Array.from(jitiVersionsInLock).join(', ')}. ` +
    `The bundled jiti won't be resolvable by the workspace.`
  );
}

mkdirSync(join(bundleDir, 'node_modules'), {recursive: true});
safeCopyDir('jiti', jitiPkgRoot, join(bundleDir, 'node_modules', 'jiti'));

/**
 * Enumerate all bundled third-party packages (by name + version) and write
 * license notices from each package's LICENSE file or package.json SPDX field.
 * Output is written to bundle/THIRD_PARTY_NOTICES.txt for reviewability.
 */
if (buildResult.metafile && buildResult.metafile.inputs) {
  const packages = new Map(); // Map<"name@version", {name, version, licenseText}>

  for (const inputPath of Object.keys(buildResult.metafile.inputs)) {
    // Metafile inputs are relative to absWorkingDir (actionsDir), e.g.
    // ../../node_modules/.pnpm/@foo+bar@1.0.0/node_modules/@foo/bar/lib/file.js
    // Resolving the package name via require.resolve() depends on pnpm's
    // hoisting/visibility from actionsDir or repoRoot, which most transitive
    // deps (e.g. @jsforce/jsforce-node, undici, semver) are NOT visible
    // through — that silently undercounted bundled packages from ~40 down to
    // 5. Derive the package name AND its real on-disk root directly from this
    // input path instead, which is always correct regardless of hoisting.
    const absInputPath = resolve(actionsDir, inputPath);
    const lastNodeModulesIdx = absInputPath.lastIndexOf('/node_modules/');
    if (lastNodeModulesIdx === -1) continue; // workspace-internal source file, not third-party

    const afterNodeModules = absInputPath.slice(lastNodeModulesIdx + '/node_modules/'.length);
    const match = afterNodeModules.match(/^(@[^/]+\/[^/]+|[^/@][^/]*)/);
    if (!match) continue;
    const pkgName = match[1];

    const pkgRoot = absInputPath.slice(0, lastNodeModulesIdx) + '/node_modules/' + pkgName;
    const pkgJsonPath = join(pkgRoot, 'package.json');

    let pkgVersion;
    try {
      pkgVersion = JSON.parse(readFileSync(pkgJsonPath, 'utf8')).version;
    } catch {
      continue; // No readable package.json at the derived root — skip.
    }

    if (!pkgVersion) {
      continue;
    }

    const key = `${pkgName}@${pkgVersion}`;
    if (packages.has(key)) {
      continue; // Already recorded
    }

    // Look for license file (LICENSE, LICENSE.md, LICENSE.txt, license, license.md, etc.)
    let licenseText = null;

    for (const filename of ['LICENSE', 'LICENSE.md', 'LICENSE.txt', 'license', 'license.md']) {
      const candidate = join(pkgRoot, filename);
      if (existsSync(candidate)) {
        try {
          licenseText = readFileSync(candidate, 'utf8');
          break;
        } catch {
          // Skip unreadable license files
        }
      }
    }

    // Fallback to SPDX identifier from package.json
    if (!licenseText) {
      try {
        const pkgJsonData = JSON.parse(readFileSync(join(pkgRoot, 'package.json'), 'utf8'));
        licenseText = pkgJsonData.license || '(no license field in package.json)';
      } catch {
        licenseText = '(license file not readable)';
      }
    }

    packages.set(key, {name: pkgName, version: pkgVersion, licenseText});
  }

  // Write the notices file
  const noticesPath = join(bundleDir, 'THIRD_PARTY_NOTICES.txt');
  const noticesLines = [
    '# Third-Party Notices',
    `# Generated from esbuild metafile for bundled third-party packages.`,
    `# Total: ${packages.size} third-party packages`,
    '',
  ];

  if (packages.size > 0) {
    for (const {name, version, licenseText} of packages.values()) {
      noticesLines.push(`## ${name}@${version}`);
      noticesLines.push('');
      if (typeof licenseText === 'string' && licenseText.length > 5000) {
        noticesLines.push(licenseText.slice(0, 5000));
        noticesLines.push('[... license text truncated ...]');
      } else {
        noticesLines.push(licenseText);
      }
      noticesLines.push('');
      noticesLines.push('---');
      noticesLines.push('');
    }
  } else {
    noticesLines.push('(No third-party packages detected in metafile. This may indicate all code is internal or workspace-local.)');
  }

  // Actually write the notices file:
  mkdirSync(dirname(noticesPath), {recursive: true});
  writeFileSync(noticesPath, noticesLines.join('\n') + '\n', 'utf8');

  console.log(`Wrote third-party notices: ${noticesPath} (${packages.size} packages)`);
}

// Write metafile to a file outside the bundle for task 4.2 (license notices)
// and future task 4.1 (reproducibility verification).
const metafilePath = join(actionsDir, 'bundle-metafile.json');
if (buildResult.metafile) {
  mkdirSync(dirname(metafilePath), {recursive: true});
  writeFileSync(metafilePath, JSON.stringify(buildResult.metafile, null, 2), 'utf8');
  console.log(`Wrote esbuild metafile: ${metafilePath}`);
}

// Compute bundle size using Node (cross-platform alternative to Unix `du`).
function computeDirSize(dir) {
  let totalBytes = 0;
  const walk = (d) => {
    try {
      for (const entry of readdirSync(d)) {
        const fullPath = join(d, entry);
        const stat = statSync(fullPath);
        if (stat.isDirectory()) {
          walk(fullPath);
        } else if (stat.isFile()) {
          totalBytes += stat.size;
        }
      }
    } catch {
      // Skip unreadable entries
    }
  };
  walk(dir);
  return totalBytes;
}

function formatBytes(bytes) {
  const units = ['B', 'KB', 'MB', 'GB'];
  let size = bytes;
  let unitIdx = 0;
  while (size >= 1024 && unitIdx < units.length - 1) {
    size /= 1024;
    unitIdx++;
  }
  return `${size.toFixed(1)}${units[unitIdx]}`;
}

const sizeStr = formatBytes(computeDirSize(bundleDir));
console.log(`\nBundle ready: ${sizeStr}\t${bundleDir}`);
