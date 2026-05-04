import type {
  HookContext, LifecycleHooks, Logger,
} from '@b64/sfpm-core';

import {ManagedPackageRef} from '@b64/sfpm-core';
import {Connection, Org} from '@salesforce/core';

const SUBSCRIBER_PKG_VERSION_ID_PREFIX = '04t';

export interface ManagedPackageHooksOptions {
  /** If true, throw on install failure; otherwise log a warning and continue. Defaults to true. */
  failOnError?: boolean;
}

/**
 * Creates a lifecycle hook that ensures managed package dependencies are
 * installed in the target org before deploying/installing a package.
 *
 * Runs as a pre-install hook. For each dependency listed in the package's
 * `dependencies` array that resolves to a subscriber package version ID (04t),
 * it checks whether the package is already installed. If not, it installs it
 * via the Tooling API `PackageInstallRequest`.
 *
 * @param options - Hook configuration options
 * @returns A LifecycleHooks instance to pass to `defineConfig({ hooks: [...] })`
 *
 * @example
 * ```typescript
 * // sfpm.config.ts
 * import { defineConfig } from '@b64/sfpm-core';
 * import { managedPackageHooks } from '@b64/sfpm-hooks';
 *
 * export default defineConfig({
 *   hooks: [
 *     managedPackageHooks(),
 *   ],
 * });
 * ```
 */
export function managedPackageHooks(options?: ManagedPackageHooksOptions): LifecycleHooks {
  const failOnError = options?.failOnError ?? true;

  return {
    enforce: 'pre',
    hooks: [
      {
        async handler(context: HookContext) {
          const {logger, packageName} = context;
          const packageDefinition = (context.sfpmPackage as any)?.packageDefinition;
          const packageAliases = (context.packageAliases ?? {}) as Record<string, string>;

          if (!packageDefinition?.dependencies?.length) {
            logger?.debug(`ManagedPackage: no dependencies for '${packageName}', skipping`);
            return;
          }

          // Resolve managed dependencies — those whose alias is a 04t subscriber version ID
          const managedDeps: ManagedPackageRef[] = [];
          for (const dep of packageDefinition.dependencies) {
            const aliasValue = packageAliases[dep.package];
            if (aliasValue?.startsWith(SUBSCRIBER_PKG_VERSION_ID_PREFIX)) {
              managedDeps.push(new ManagedPackageRef(dep.package, aliasValue));
            }
          }

          if (managedDeps.length === 0) {
            logger?.debug(`ManagedPackage: no managed dependencies for '${packageName}'`);
            return;
          }

          const connection = resolveConnection(context, logger);
          if (!connection) {
            const msg = `ManagedPackage: no org connection for '${packageName}', cannot install dependencies`;
            if (failOnError) throw new Error(msg);
            logger?.warn(msg);
            return;
          }

          // Query installed packages once for all dependencies
          const installedVersionIds = await queryInstalledPackages(connection, logger);

          for (const dep of managedDeps) {
            if (installedVersionIds.has(dep.packageVersionId)) {
              logger?.info(`ManagedPackage: '${dep.packageName}' (${dep.packageVersionId}) already installed, skipping`);
              continue;
            }

            logger?.info(`ManagedPackage: installing '${dep.packageName}' (${dep.packageVersionId})`);

            try {
              // eslint-disable-next-line no-await-in-loop
              await installPackageVersion(connection, dep, logger);
              logger?.info(`ManagedPackage: '${dep.packageName}' installed successfully`);
            } catch (error) {
              const msg = `ManagedPackage: failed to install '${dep.packageName}': ${error instanceof Error ? error.message : String(error)}`;
              if (failOnError) throw new Error(msg);
              logger?.warn(msg);
            }
          }
        },
        operation: 'install',
        timing: 'pre' as const,
      },
    ],
    name: 'managed-package',
  };
}

// ============================================================================
// Helpers
// ============================================================================

function resolveConnection(context: HookContext, logger?: Logger): Connection | undefined {
  const org = context.org as Org | undefined;
  if (!org) {
    logger?.debug('ManagedPackage: no org in hook context');
    return undefined;
  }

  return org.getConnection();
}

/**
 * Query the org for all installed subscriber package version IDs.
 */
async function queryInstalledPackages(connection: Connection, logger?: Logger): Promise<Set<string>> {
  try {
    const result = await connection.tooling.query<{SubscriberPackageVersionId: string}>('SELECT SubscriberPackageVersionId FROM InstalledSubscriberPackage');

    const ids = new Set((result.records ?? []).map(r => r.SubscriberPackageVersionId));
    logger?.debug(`ManagedPackage: found ${ids.size} installed package(s) in org`);
    return ids;
  } catch (error) {
    logger?.warn(`ManagedPackage: failed to query installed packages: ${error instanceof Error ? error.message : String(error)}`);
    return new Set();
  }
}

/**
 * Install a subscriber package version via the Tooling API.
 */
async function installPackageVersion(
  connection: Connection,
  dep: ManagedPackageRef,
  logger?: Logger,
): Promise<void> {
  const installRequest = {
    ApexCompileType: 'package',
    NameConflictResolution: 'Block',
    Password: '',
    SecurityType: 'Full',
    SubscriberPackageVersionKey: dep.packageVersionId,
  };

  const result = await connection.tooling.create('PackageInstallRequest', installRequest);

  if (!result.success || !result.id) {
    throw new Error(`Failed to create install request: ${JSON.stringify(result.errors || [])}`);
  }

  const requestId = result.id as string;
  logger?.debug(`ManagedPackage: install request created: ${requestId}`);

  // Poll for completion
  const maxAttempts = 120; // 10 minutes at 5-second intervals
  let attempts = 0;

  while (attempts < maxAttempts) {
    // eslint-disable-next-line no-await-in-loop
    const record = await connection.tooling.retrieve('PackageInstallRequest', requestId);

    if (!record) {
      throw new Error(`Could not retrieve PackageInstallRequest: ${requestId}`);
    }

    const status = (record as Record<string, unknown>).Status as string;

    if (status === 'SUCCESS') return;

    if (status === 'ERROR') {
      const errors = (record as any).Errors?.errors?.map((e: {message: string}) => e.message).join('\n') || 'Unknown error';
      throw new Error(`Installation failed:\n${errors}`);
    }

    // eslint-disable-next-line no-await-in-loop, no-promise-executor-return
    await new Promise(resolve => setTimeout(resolve, 5000));
    attempts++;
  }

  throw new Error(`Installation timed out after ${maxAttempts * 5} seconds`);
}
