import type {DeploymentOptions, Logger} from '@b64/sfpm-core';

import {HookContext, LifecycleHooks} from '@b64/sfpm-core';
import {Connection, Org} from '@salesforce/core';

import type {PermissionSetHooksOptions} from './types.js';

import {PermissionSetAssigner} from './permset-assigner.js';

/**
 * Shape expected on the hook context's `sfpmPackage` for reading
 * permission set assignments from the package definition.
 */
interface PermSetCapablePackage {
  packageDefinition?: {
    packageOptions?: {
      deploy?: DeploymentOptions;
    };
  };
}

/**
 * Creates lifecycle hooks for assigning permission sets during installation.
 *
 * Registers hooks on `install:pre` and `install:post` that assign
 * permission sets to the target org user. Permission set names are
 * read from the package definition's `deploy.pre.assignPermSets` and
 * `deploy.post.assignPermSets` arrays. Any names in {@link options.permSets}
 * are merged into the post-install list.
 *
 * Already-assigned permission sets are detected and skipped automatically.
 *
 * @param options - Hook configuration options
 * @returns A LifecycleHooks instance to pass to `defineConfig({ hooks: [...] })`
 *
 * @example
 * ```typescript
 * // sfpm.config.ts
 * import { defineConfig } from '@b64/sfpm-core';
 * import { permissionSetHooks } from '@b64/sfpm-hooks';
 *
 * export default defineConfig({
 *   hooks: [
 *     permissionSetHooks(),
 *     // or with explicit extras:
 *     permissionSetHooks({ permSets: ['MyAdminPermSet'] }),
 *   ],
 * });
 * ```
 */
export function permissionSetHooks(options?: PermissionSetHooksOptions): LifecycleHooks {
  const failOnError = options?.failOnError ?? false;
  const extraPermSets = options?.permSets ?? [];

  return {
    hooks: [
      {
        async handler(context: HookContext) {
          const {logger, packageName} = context;
          const deployOptions = resolveDeployOptions(context);
          const prePermSets = deployOptions?.pre?.assignPermSets ?? [];

          if (prePermSets.length === 0) {
            logger?.debug(`PermissionSet [pre]: no permission sets to assign for '${packageName}'`);
            return;
          }

          const connection = resolveConnection(context, logger);
          if (!connection) {
            logger?.warn(`PermissionSet [pre]: no org connection for '${packageName}', skipping`);
            return;
          }

          logger?.info(`PermissionSet [pre]: assigning ${prePermSets.length} permission set(s) for '${packageName}'`);

          const assigner = new PermissionSetAssigner(connection, logger);
          const result = await assigner.assign(prePermSets);

          handleResult(result, 'pre', packageName, failOnError, logger);
        },
        phase: 'install',
        timing: 'pre' as const,
      },
      {
        async handler(context: HookContext) {
          const {logger, packageName} = context;
          const deployOptions = resolveDeployOptions(context);
          const postPermSets = deduplicate([
            ...(deployOptions?.post?.assignPermSets ?? []),
            ...extraPermSets,
          ]);

          if (postPermSets.length === 0) {
            logger?.debug(`PermissionSet [post]: no permission sets to assign for '${packageName}'`);
            return;
          }

          const connection = resolveConnection(context, logger);
          if (!connection) {
            logger?.warn(`PermissionSet [post]: no org connection for '${packageName}', skipping`);
            return;
          }

          logger?.info(`PermissionSet [post]: assigning ${postPermSets.length} permission set(s) for '${packageName}'`);

          const assigner = new PermissionSetAssigner(connection, logger);
          const result = await assigner.assign(postPermSets);

          handleResult(result, 'post', packageName, failOnError, logger);
        },
        phase: 'install',
        timing: 'post' as const,
      },
    ],
    name: 'permission-set',
  };
}

// ============================================================================
// Helpers
// ============================================================================

/**
 * Extract deploy options from the package definition on the hook context.
 */
function resolveDeployOptions(context: HookContext): DeploymentOptions | undefined {
  const sfpmPackage = context.sfpmPackage as PermSetCapablePackage | undefined;
  return sfpmPackage?.packageDefinition?.packageOptions?.deploy;
}

/**
 * Resolve a Salesforce {@link Connection} from the hook context.
 */
function resolveConnection(
  context: HookContext,
  logger?: Logger,
): Connection | undefined {
  const {org} = context;

  if (org instanceof Org) {
    return org.getConnection();
  }

  logger?.debug('PermissionSet: context.org is not an Org instance');
  return undefined;
}

/**
 * Process the assignment result — throw on failure if configured, else warn.
 */
function handleResult(
  result: {assigned: string[]; failed: Array<{message: string; name: string}>; skipped: string[]},
  timing: 'post' | 'pre',
  packageName: string | undefined,
  failOnError: boolean,
  logger?: Logger,
): void {
  if (result.assigned.length > 0) {
    logger?.info(`PermissionSet [${timing}]: assigned ${result.assigned.join(', ')} for '${packageName}'`);
  }

  if (result.skipped.length > 0) {
    logger?.debug(`PermissionSet [${timing}]: already assigned ${result.skipped.join(', ')} for '${packageName}'`);
  }

  if (result.failed.length > 0) {
    const summary = result.failed.map(f => `${f.name}: ${f.message}`).join('; ');
    const message = `PermissionSet [${timing}]: failed assignments for '${packageName}': ${summary}`;

    if (failOnError) {
      throw new Error(message);
    }

    logger?.warn(message);
  }
}

/**
 * Remove duplicate strings while preserving order.
 */
function deduplicate(values: string[]): string[] {
  return [...new Set(values)];
}
