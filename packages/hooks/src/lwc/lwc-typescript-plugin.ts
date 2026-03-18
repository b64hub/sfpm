import {HookContext, LifecycleHooks} from '@b64/sfpm-core';

import type {LwcTypescriptHooksOptions} from './types.js';

/**
 * Creates lifecycle hooks for compiling LWC TypeScript to JavaScript.
 *
 * Registers a hook on `build:pre` that compiles TypeScript files within
 * LWC component directories into JavaScript. This enables authoring
 * LWC controllers in TypeScript while deploying valid JS to Salesforce.
 *
 * The compiled `.js` output replaces the `.ts` source in the staging
 * directory so that downstream build and deploy steps work transparently.
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
  return {
    hooks: [
      {
        async handler(context: HookContext) {
          const {logger, packageName} = context;

          logger?.info(`LWC TypeScript: compiling TypeScript for '${packageName}'`);

          // TODO: Resolve LWC source directories from package path
          // TODO: Discover .ts files matching options.include / options.exclude
          // TODO: Load or create tsconfig (options.tsconfig or built-in defaults)
          // TODO: Compile TypeScript to JavaScript
          // TODO: Write compiled .js files to staging directory
          // TODO: Remove .ts source files if options.removeSourceFiles

          logger?.debug(`LWC TypeScript: completed for '${packageName}'`);
        },
        phase: 'build',
        timing: 'pre',
      },
    ],

    name: 'lwc-typescript',
  };
}
