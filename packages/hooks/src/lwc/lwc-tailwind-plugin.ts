import {HookContext, LifecycleHooks} from '@b64/sfpm-core';

import type {LwcTailwindHooksOptions} from './types.js';

/**
 * Creates lifecycle hooks for generating Tailwind CSS for LWC.
 *
 * Registers a hook on `build:pre` that scans LWC templates and
 * controllers for Tailwind utility classes, then generates scoped
 * CSS files for each component. This allows the generated CSS to
 * be gitignored while keeping Tailwind as the authoring format.
 *
 * @param options - Hook configuration options
 * @returns A LifecycleHooks instance to pass to `defineConfig({ hooks: [...] })`
 *
 * @example
 * ```typescript
 * // sfpm.config.ts
 * import { defineConfig } from '@b64/sfpm-core';
 * import { lwcTailwindHooks } from '@b64/sfpm-hooks';
 *
 * export default defineConfig({
 *   hooks: [
 *     lwcTailwindHooks({ scopeStyles: true }),
 *   ],
 * });
 * ```
 */
export function lwcTailwindHooks(options?: LwcTailwindHooksOptions): LifecycleHooks {
  return {
    hooks: [
      {
        async handler(context: HookContext) {
          const {logger, packageName} = context;

          logger?.info(`LWC Tailwind: generating CSS for '${packageName}'`);

          // TODO: Locate Tailwind config (options.configPath or auto-discover)
          // TODO: Scan LWC templates and controllers for Tailwind classes
          // TODO: Generate scoped CSS output per component
          // TODO: Apply LWC-specific CSS scoping if options.scopeStyles
          // TODO: Write CSS files to staging directory

          logger?.debug(`LWC Tailwind: completed for '${packageName}'`);
        },
        operation: 'build',
        timing: 'pre',
      },
    ],

    name: 'lwc-tailwind',
  };
}
