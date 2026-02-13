import {HookContext, LifecycleHooks} from '@b64/sfpm-core';

import {ProfileCleaner, findProfilesDirectory} from './profile-cleaner.js';
import {ProfileHooksOptions} from './types.js';

/**
 * Creates lifecycle hooks for profile cleaning and reconciliation.
 *
 * Registers a hook on `install:pre` that cleans profile XML files
 * before deployment. This removes permissions that reference metadata not
 * present in the package, preventing deployment failures.
 *
 * @param options - Hook configuration options
 * @returns A LifecycleHooks instance to pass to `defineConfig({ hooks: [...] })`
 *
 * @example
 * ```typescript
 * // sfpm.config.ts
 * import { defineConfig } from '@b64/sfpm-core';
 * import { profileHooks } from '@b64/sfpm-profiles';
 *
 * export default defineConfig({
 *   hooks: [
 *     profileHooks({ reconcile: true, removeLoginIpRanges: true }),
 *   ],
 * });
 * ```
 */
export function profileHooks(options?: ProfileHooksOptions): LifecycleHooks {
  const _cleaner = new ProfileCleaner(options);

  return {
    name: 'profiles',

    hooks: [
      {
        phase: 'install',
        timing: 'pre',
        handler: async (context: HookContext) => {
          const {packageName, logger} = context;

          // Determine the package source path for profile discovery
          const packagePath = context.packagePath as string | undefined
            ?? context.stagingDirectory as string | undefined;

          if (!packagePath) {
            logger?.debug(`Profiles: no package path available for '${packageName}', skipping`);
            return;
          }

          const profilesDir = findProfilesDirectory(packagePath);
          if (!profilesDir) {
            logger?.debug(`Profiles: no profiles directory found for '${packageName}'`);
            return;
          }

          logger?.info(`Profiles: cleaning profiles for '${packageName}'`);

          // TODO: invoke _cleaner once implementation is migrated
        },
      },
    ],
  };
}
