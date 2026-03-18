import {HookContext, LifecycleHooks} from '@b64/sfpm-core';

import type {PicklistHooksOptions} from './types.js';

/**
 * Creates lifecycle hooks for enabling picklist values post-deployment.
 *
 * Registers a hook on `install:post` that enables deployed picklist
 * values in the target org. Picklist values included in metadata
 * deployments may arrive as inactive — this hook ensures they are
 * activated automatically.
 *
 * @param options - Hook configuration options
 * @returns A LifecycleHooks instance to pass to `defineConfig({ hooks: [...] })`
 *
 * @example
 * ```typescript
 * // sfpm.config.ts
 * import { defineConfig } from '@b64/sfpm-core';
 * import { picklistHooks } from '@b64/sfpm-hooks';
 *
 * export default defineConfig({
 *   hooks: [
 *     picklistHooks({ activationStrategy: 'new' }),
 *   ],
 * });
 * ```
 */
export function picklistHooks(options?: PicklistHooksOptions): LifecycleHooks {
  return {
    hooks: [
      {
        async handler(context: HookContext) {
          const {logger, packageName} = context;

          logger?.info(`Picklist: enabling picklist values for '${packageName}'`);

          // TODO: Scan deployed metadata for picklist value sets
          // TODO: Query target org for existing picklist field definitions
          // TODO: Enable inactive picklist values via Metadata API
          // TODO: Respect options.fieldNames filter
          // TODO: Respect options.activationStrategy

          logger?.debug(`Picklist: completed for '${packageName}'`);
        },
        phase: 'install',
        timing: 'post',
      },
    ],

    name: 'picklist',
  };
}
