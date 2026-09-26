/**
 * Third-party package identification and licence-file lookup, shared by the
 * NOTICE writer and the jiti shim entry in `build-action-bundle.mjs`.
 *
 * Paths below are normalised to `/` once, at the top of `resolvePackage`, so
 * the rest of the module can use plain string matching without special-casing
 * `path.sep` on Windows.
 */
import {existsSync, readdirSync, readFileSync} from 'node:fs';
import {join} from 'node:path';

const NODE_MODULES = '/node_modules/';
const PACKAGE_NAME_PATTERN = /^(@[^/]+\/[^/]+|[^/@][^/]*)/;
const LICENSE_CANDIDATES = ['LICENSE', 'LICENSE.md', 'LICENSE.txt', 'LICENCE', 'LICENCE.md', 'COPYING'];
const NOTICE_CANDIDATES = ['NOTICE', 'NOTICE.txt'];

/** Normalises Windows `\` separators to `/` for string-based path matching. */
function toPosix(path) {
  return path.replaceAll('\\', '/');
}

/**
 * Resolves the third-party package that owns `absInputPath` (an absolute
 * esbuild metafile input path): its name, on-disk root directory, and parsed
 * `package.json`.
 *
 * Uses the LAST `/node_modules/` segment in the path, so a package that is
 * itself nested inside another package's `node_modules` (pnpm's virtual
 * store layout, or a plain nested-dependency install) resolves to its OWN
 * root — not an ancestor's. This also makes it safe to reuse for finding a
 * specific library's `lib/` directory by name: match `resolved.name` against
 * the library you're looking for, no separate `/lib/`-index-of needed.
 *
 * Returns `null` for a workspace-internal file (no `node_modules` segment) or
 * a resolved root with no readable, versioned `package.json`.
 */
export function resolvePackage(absInputPath) {
  const posixPath = toPosix(absInputPath);
  const lastIdx = posixPath.lastIndexOf(NODE_MODULES);
  if (lastIdx === -1) return null;

  const afterNodeModules = posixPath.slice(lastIdx + NODE_MODULES.length);
  const match = afterNodeModules.match(PACKAGE_NAME_PATTERN);
  if (!match) return null;

  const name = match[1];
  const pkgRoot = posixPath.slice(0, lastIdx + NODE_MODULES.length) + name;
  const pkgJsonPath = join(pkgRoot, 'package.json');
  if (!existsSync(pkgJsonPath)) return null;

  let pkgJson;
  try {
    pkgJson = JSON.parse(readFileSync(pkgJsonPath, 'utf8'));
  } catch {
    return null;
  }

  if (!pkgJson.version) return null;

  return {
    name, pkgJson, pkgRoot, version: pkgJson.version,
  };
}

/** First matching candidate file in `dir`, tried in order, else a case-insensitive `license*`/`licence*` fallback. Returns the full path, or `null`. */
function findCandidateFile(dir, candidates) {
  for (const filename of candidates) {
    const full = join(dir, filename);
    if (existsSync(full)) return full;
  }

  const entries = existsSync(dir) ? readdirSync(dir) : [];
  const fallback = entries.find(entry => /^licen[cs]e/i.test(entry));
  return fallback ? join(dir, fallback) : null;
}

/** Licence text for a package: its own LICENSE-shaped file if present, else the `license` field from its `package.json`, else `null`. */
export function findLicenseText(pkgRoot, pkgJson) {
  const file = findCandidateFile(pkgRoot, LICENSE_CANDIDATES);
  if (file) return readFileSync(file, 'utf8');
  return pkgJson?.license ? String(pkgJson.license) : null;
}

/** NOTICE file text for a package, or `null` if it has none. */
export function findNoticeText(pkgRoot) {
  const file = findCandidateFile(pkgRoot, NOTICE_CANDIDATES);
  return file ? readFileSync(file, 'utf8') : null;
}
