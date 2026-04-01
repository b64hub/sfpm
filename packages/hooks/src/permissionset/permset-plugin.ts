import type {Logger} from '@b64/sfpm-core';

import {HookContext, LifecycleHooks, resolveHookConfig} from '@b64/sfpm-core';
import {Connection, Org} from '@salesforce/core';

import type {PermissionSetHooksOptions} from './types.js';

import {PermissionSetAssigner} from './permset-assigner.js';

/**
 * Per-package hook overrides for permission set assignment.
 *
 * Placed under `packageOptions.hooks["permission-set"]` in `sfdx-project.json`:
 * ```json
 * {
 *   "hooks": {
 *     "permission-set": {
 *       "pre": ["ReadOnlyUser"],
 *       "post": ["AdminPermSet"]
 *     }
 *   }
 * }
 * ```
 */
interface PermSetHookOverrides {
  /** Permission set API names to assign after installation. */
  post?: string[];
  /** Permission set API names to assign before installation. */
  pre?: string[];
}

/**
 * Creates lifecycle hooks for assigning permission sets during installation.
 *
 * Registers hooks on `install:pre` and `install:post` that assign
 * permission sets to the target org user.
 *
 * Permission set names are resolved from **two sources** (merged, deduplicated):
 *
 * 1. **Global options** — `permissionSetHooks({ permSets: [...] })` in `sfpm.config.ts`
 * 2. **Per-package overrides** — `packageOptions.hooks["permission-set"].pre/post`
 *
 * When a per-package `hooks["permission-set"]` is set to `false`, the hook is
 * skipped entirely for that package (handled by the lifecycle engine).
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
 *     permissionSetHooks({ permSets: ['SharedPermSet'], failOnError: false }),
 *   ],
 * });
 * ```
 *
 * @example
 * ```jsonc
 * // sfdx-project.json — per-package overrides
 * {
 *   "packageOptions": {
 *     "hooks": {
 *       "permission-set": { "pre": ["ReadOnly"], "post": ["Admin"] }
 *     }
 *   }
 * }
 * ```
 */
export function permissionSetHooks(options?: PermissionSetHooksOptions): LifecycleHooks {
  const failOnError = options?.failOnError ?? false;
  const globalPermSets = options?.permSets ?? [];

  return {
    hooks: [
      {
        async handler(context: HookContext) {
          const {logger, packageName} = context;
          const prePermSets = resolvePermSets(context, 'pre', []);

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
        operation: 'install',
        timing: 'pre' as const,
      },
      {
        async handler(context: HookContext) {
          const {logger, packageName} = context;
          const postPermSets = resolvePermSets(context, 'post', globalPermSets);

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
        operation: 'install',
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
 * Resolve the permission set list for a given timing by merging:
 * 1. Per-package overrides from `packageOptions.hooks["permission-set"].pre/post`
 * 2. Global defaults from `sfpm.config.ts` options
 */
function resolvePermSets(
  context: HookContext,
  timing: 'post' | 'pre',
  globalPermSets: string[],
): string[] {
  const {config} = resolveHookConfig<PermSetHookOverrides>(context, 'permission-set');
  const packagePermSets = (timing === 'pre' ? config.pre : config.post) ?? [];

  return deduplicate([...packagePermSets, ...globalPermSets]);
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
