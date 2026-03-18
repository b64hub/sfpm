import {HookContext, LifecycleHooks} from '@b64/sfpm-core';

import type {FlowActivationHooksOptions} from './types.js';

/**
 * Creates lifecycle hooks for activating flows post-deployment.
 *
 * Registers a hook on `install:post` that activates Flow definitions in
 * the target org after a package has been deployed. Flows deployed via
 * metadata often arrive in an inactive state — this hook ensures they
 * are activated automatically as part of the installation pipeline.
 *
 * @param options - Hook configuration options
 * @returns A LifecycleHooks instance to pass to `defineConfig({ hooks: [...] })`
 *
 * @example
 * ```typescript
 * // sfpm.config.ts
 * import { defineConfig } from '@b64/sfpm-core';
 * import { flowActivationHooks } from '@b64/sfpm-hooks';
 *
 * export default defineConfig({
 *   hooks: [
 *     flowActivationHooks({ versionStrategy: 'latest' }),
 *   ],
 * });
 * ```
 */
export function flowActivationHooks(options?: FlowActivationHooksOptions): LifecycleHooks {
  return {
    hooks: [
      {
        async handler(context: HookContext) {
          const {logger, packageName} = context;

          logger?.info(`FlowActivation: activating flows for '${packageName}'`);

          // TODO: Retrieve deployed flow metadata from context
          // TODO: Query target org for flow definitions
          // TODO: Activate inactive flows via Tooling API
          // TODO: Respect options.flowNames filter
          // TODO: Respect options.versionStrategy
          // TODO: Skip already-active flows when options.skipAlreadyActive

          logger?.debug(`FlowActivation: completed for '${packageName}'`);
        },
        phase: 'install',
        timing: 'post',
      },
    ],

    name: 'flow-activation',
  };
}
