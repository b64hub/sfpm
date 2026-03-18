import {HookContext, LifecycleHooks} from '@b64/sfpm-core';

import type {StandardValueSetHooksOptions} from './types.js';

/**
 * Creates lifecycle hooks for patching standard value sets post-install.
 *
 * Registers a hook on `install:post` that re-deploys standard value set
 * metadata to the target org. Package version installs (unlocked / managed)
 * do not always apply standard value set changes — this hook performs
 * a metadata deploy of the value set files as a follow-up step.
 *
 * @param options - Hook configuration options
 * @returns A LifecycleHooks instance to pass to `defineConfig({ hooks: [...] })`
 *
 * @example
 * ```typescript
 * // sfpm.config.ts
 * import { defineConfig } from '@b64/sfpm-core';
 * import { standardValueSetHooks } from '@b64/sfpm-hooks';
 *
 * export default defineConfig({
 *   hooks: [
 *     standardValueSetHooks({ valueSetNames: ['Industry', 'CaseOrigin'] }),
 *   ],
 * });
 * ```
 */
export function standardValueSetHooks(options?: StandardValueSetHooksOptions): LifecycleHooks {
  return {
    hooks: [
      {
        async handler(context: HookContext) {
          const {logger, packageName} = context;

          logger?.info(`StandardValueSet: patching standard value sets for '${packageName}'`);

          // TODO: Locate standard value set XML from package source or options.sourceDirectory
          // TODO: Filter to options.valueSetNames if provided
          // TODO: Deploy standard value set metadata to target org via Metadata API
          // TODO: Report results (patched count, failures)

          logger?.debug(`StandardValueSet: completed for '${packageName}'`);
        },
        phase: 'install',
        timing: 'post',
      },
    ],

    name: 'standard-value-set',
  };
}
