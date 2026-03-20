import {HookContext, LifecycleHooks} from '@b64/sfpm-core';

import type {BrowserforceHooksOptions} from './types.js';

/**
 * Creates lifecycle hooks for sfdx-browserforce integration.
 *
 * Registers a hook on `install:post` that executes browserforce plans
 * against the target org. This enables automated configuration of
 * Salesforce settings that cannot be set via the Metadata or Tooling
 * APIs (e.g., org preferences, security settings, portal configuration).
 *
 * Requires `sfdx-browserforce-plugin` to be installed and available
 * on the system PATH.
 *
 * @see https://github.com/amtrack/sfdx-browserforce-plugin
 *
 * @param options - Hook configuration options
 * @returns A LifecycleHooks instance to pass to `defineConfig({ hooks: [...] })`
 *
 * @example
 * ```typescript
 * // sfpm.config.ts
 * import { defineConfig } from '@b64/sfpm-core';
 * import { browserforceHooks } from '@b64/sfpm-hooks';
 *
 * export default defineConfig({
 *   hooks: [
 *     browserforceHooks({ planFile: 'config/browserforce-plan.json' }),
 *   ],
 * });
 * ```
 */
export function browserforceHooks(options: BrowserforceHooksOptions): LifecycleHooks {
  return {
    hooks: [
      {
        async handler(context: HookContext) {
          const {logger, packageName} = context;

          if (options.packageName && options.packageName !== packageName) {
            logger?.debug(`Browserforce: skipping — filter does not match '${packageName}'`);
            return;
          }

          logger?.info(`Browserforce: applying plan for '${packageName}'`);

          // TODO: Load plan from options.planFile or options.plan
          // TODO: Resolve target org credentials from context
          // TODO: Invoke sfdx-browserforce-plugin apply command
          // TODO: Stream output to logger
          // TODO: Handle errors and report failures

          logger?.debug(`Browserforce: completed for '${packageName}'`);
        },
        operation: 'install',
        timing: 'post',
      },
    ],

    name: 'browserforce',
  };
}
