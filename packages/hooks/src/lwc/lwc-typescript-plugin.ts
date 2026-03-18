import type {Logger} from '@b64/sfpm-core';

import {HookContext, LifecycleHooks} from '@b64/sfpm-core';
import {spawn} from 'node:child_process';
import {
  existsSync, readdirSync, statSync, unlinkSync,
} from 'node:fs';
import {join} from 'node:path';

import type {LwcTypescriptHooksOptions} from './types.js';

/**
 * Package-like shape expected on the hook context for LWC TS compilation.
 */
interface LwcCapablePackage {
  packageDirectory?: string;
}

/**
 * Creates lifecycle hooks for compiling LWC TypeScript to JavaScript.
 *
 * Registers a hook on `build:pre` that runs `tsc` inside the `lwc/`
 * directory of the staged package. This enables authoring LWC controllers
 * in TypeScript while keeping `.js` files out of version control.
 *
 * The compiled `.js` output is written to the staging directory so that
 * downstream build and deploy steps work transparently. Original `.ts`
 * source files are removed by default.
 *
 * @param options - Hook configuration options
 * @returns A LifecycleHooks instance to pass to `defineConfig({ hooks: [...] })`
 *
 * @example
 * ```typescript
 * // sfpm.config.ts
 * import { defineConfig } from '@b64/sfpm-core';
 * import { lwcTypescriptHooks } from '@b64/sfpm-hooks';
 *
 * export default defineConfig({
 *   hooks: [
 *     lwcTypescriptHooks({ removeSourceFiles: true }),
 *   ],
 * });
 * ```
 */
export function lwcTypescriptHooks(options?: LwcTypescriptHooksOptions): LifecycleHooks {
  const removeSourceFiles = options?.removeSourceFiles ?? true;

  return {
    hooks: [
      {
        async handler(context: HookContext) {
          const {logger, packageName} = context;
          const sfpmPackage = context.sfpmPackage as LwcCapablePackage | undefined;

          const packageDir = sfpmPackage?.packageDirectory;
          if (!packageDir) {
            logger?.debug(`LWC TypeScript: no package directory for '${packageName}', skipping`);
            return;
          }

          // ── Locate lwc directory ──────────────────────────────────
          const lwcDir = findLwcDirectory(packageDir);
          if (!lwcDir) {
            logger?.debug(`LWC TypeScript: no lwc directory found for '${packageName}', skipping`);
            return;
          }

          // ── Guard: check for .ts files ────────────────────────────
          const tsFiles = collectTsFiles(lwcDir);
          if (tsFiles.length === 0) {
            logger?.debug(`LWC TypeScript: no .ts files in '${packageName}', skipping`);
            return;
          }

          logger?.info(`LWC TypeScript: compiling ${tsFiles.length} TypeScript file(s) for '${packageName}'`);

          // ── Run tsc ───────────────────────────────────────────────
          const tscArgs = options?.tsconfig
            ? ['--project', options.tsconfig]
            : [];

          const result = await runTsc(tscArgs, lwcDir, logger);
          if (!result.success) {
            throw new Error(`LWC TypeScript: compilation failed for '${packageName}':\n${result.output}`);
          }

          // ── Remove .ts source files ───────────────────────────────
          if (removeSourceFiles) {
            for (const file of tsFiles) {
              unlinkSync(file);
            }

            logger?.debug(`LWC TypeScript: removed ${tsFiles.length} .ts source file(s)`);
          }

          logger?.debug(`LWC TypeScript: completed for '${packageName}'`);
        },
        phase: 'build',
        timing: 'pre',
      },
    ],

    name: 'lwc-typescript',
  };
}

// ============================================================================
// Helpers
// ============================================================================

/**
 * Locate the `lwc` directory under the package directory.
 * Checks common Salesforce DX paths.
 */
function findLwcDirectory(packageDirectory: string): string | undefined {
  const candidates = [
    join(packageDirectory, 'lwc'),
    join(packageDirectory, 'main', 'default', 'lwc'),
  ];

  return candidates.find(p => existsSync(p));
}

/**
 * Recursively collect `.ts` files under a directory, excluding `.d.ts` and `__tests__`.
 */
function collectTsFiles(dir: string): string[] {
  const files: string[] = [];

  for (const entry of readdirSync(dir)) {
    const fullPath = join(dir, entry);
    const stat = statSync(fullPath);

    if (stat.isDirectory()) {
      if (entry === '__tests__' || entry === 'node_modules') continue;
      files.push(...collectTsFiles(fullPath));
    } else if (entry.endsWith('.ts') && !entry.endsWith('.d.ts')) {
      files.push(fullPath);
    }
  }

  return files;
}

/**
 * Spawn `tsc` and collect output.
 */
function runTsc(
  args: string[],
  cwd: string,
  logger?: Logger,
): Promise<{output: string; success: boolean}> {
  return new Promise(resolve => {
    const child = spawn('npx', ['tsc', ...args], {
      cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let output = '';

    child.stdout.on('data', (data: Buffer) => {
      output += data.toString();
    });

    child.stderr.on('data', (data: Buffer) => {
      output += data.toString();
    });

    child.on('close', code => {
      if (code !== 0) {
        logger?.debug(`LWC TypeScript: tsc exited with code ${code}`);
      }

      resolve({output, success: code === 0});
    });

    child.on('error', error => {
      resolve({output: error.message, success: false});
    });
  });
}
