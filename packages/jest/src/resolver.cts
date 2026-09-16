/**
 * This module compiles to plain CommonJS (`resolver.cjs`) and is `require()`d
 * directly and synchronously by Jest's `resolver` config option — `require` is
 * therefore the correct, deliberate tool here, not a lint violation.
 */
/* eslint-disable @typescript-eslint/no-require-imports, unicorn/prefer-module */
import fs from 'node:fs';
import path from 'node:path';

const NS = 'c';
const LWC_DIRS_ENV = 'SFPM_JEST_LWC_DIRS';

function getInfoFromId(id: string): {name: string; ns: string} {
  const idx = id.indexOf('/');
  return idx === -1 ? {name: '', ns: id} : {name: id.slice(idx + 1), ns: id.slice(0, idx)};
}

function isFile(file: string): boolean {
  try {
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
}

function resolveAsFile(base: string, extensions: string[]): string | undefined {
  for (const ext of extensions) {
    const file = base + ext;
    if (isFile(file)) return file;
  }

  return undefined;
}

function getLwcDirs(): string[] {
  const raw = process.env[LWC_DIRS_ENV];
  if (!raw) {
    throw new Error(`@b64hub/sfpm-jest/resolver: ${LWC_DIRS_ENV} is not set. Call setupLwcResolver() from your jest.config.js before returning the config (see @b64hub/sfpm-jest).`);
  }

  return JSON.parse(raw) as string[];
}

// lightning/* stubs live in sfdx-lwc-jest's own bundled folder — reuse it
// rather than reimplementing them.
function getLightningStubsDir(): string {
  return path.join(path.dirname(require.resolve('@salesforce/sfdx-lwc-jest/package.json')), 'src', 'lightning-stubs');
}

interface ResolverOptions {
  extensions: string[];
}

function resolver(modulePath: string, options: ResolverOptions): string {
  // ALLOWLISTED_LWC_PACKAGES in @lwc/jest-resolver covers wire-service(-jest-util)
  // but not the raw `lwc` specifier, which must resolve to the CJS-built engine.
  if (modulePath === 'lwc') {
    return require.resolve('@lwc/engine-dom');
  }

  const {name, ns} = getInfoFromId(modulePath);

  if (ns === 'lightning') {
    const stub = path.join(getLightningStubsDir(), name, `${name}.js`);
    if (isFile(stub)) return stub;
  }

  if (ns === NS) {
    for (const dir of getLwcDirs()) {
      const file = resolveAsFile(path.join(dir, name, name), options.extensions);
      if (file) return fs.realpathSync(file);
    }
  }

  // Fallback must be @lwc/jest-resolver (not Jest's defaultResolver) — it
  // handles scoped CSS (?scoped=true), implicit HTML/CSS imports, etc.
  const lwcJestResolver = require('@lwc/jest-resolver') as (modulePath: string, options: ResolverOptions) => string;
  return lwcJestResolver(modulePath, options);
}

export = resolver;
