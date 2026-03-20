import type {Connection} from '@salesforce/core';

import {
  HookContext, LifecycleHooks, type Logger, PackageType,
} from '@b64/sfpm-core';
import {Org} from '@salesforce/core';
import {existsSync} from 'node:fs';
import {join} from 'node:path';

import type {StandardValueSetHooksOptions} from './types.js';

import {StandardValueSetDeployer} from './standard-value-set-deployer.js';

// ============================================================================
// Source Component Contracts
// ============================================================================

/**
 * Minimal interface for a package that exposes standard value set info.
 * Satisfied by `SfpmMetadataPackage`.
 */
interface SvsCapablePackage {
  /** The package's resolved source directory within the staging area. */
  packageDirectory?: string;
  /** Standard value set SourceComponents from the ComponentSet. */
  standardValueSets: {fullName: string}[];
  type: string;
}

// ============================================================================
// Public API
// ============================================================================

/**
 * Creates lifecycle hooks for deploying standard value sets post-install.
 *
 * Registers a hook on `install:post` that re-deploys standard value set
 * metadata to the target org via the Metadata API. Unlocked package
 * version installs do not always apply SVS changes — this hook performs
 * a targeted source deploy of the `standardValueSets/` directory as a
 * follow-up step.
 *
 * Only runs for unlocked packages. Source packages are deployed
 * directly and don't need this fixup.
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

          // ── Guard: only process unlocked packages ────────────────
          const sfpmPackage = context.sfpmPackage as SvsCapablePackage | undefined;

          if (!sfpmPackage || String(sfpmPackage.type) !== PackageType.Unlocked) {
            logger?.debug(`StandardValueSet: skipping '${packageName}' (not an unlocked package)`);
            return;
          }

          // ── Guard: need an org connection ─────────────────────────
          const connection = resolveConnection(context, logger);
          if (!connection) {
            logger?.warn(`StandardValueSet: no org connection available for '${packageName}', skipping`);
            return;
          }

          // ── Guard: check package has SVS components ───────────────
          const svsList = sfpmPackage.standardValueSets ?? [];
          if (svsList.length === 0) {
            logger?.debug(`StandardValueSet: no standard value sets in '${packageName}'`);
            return;
          }

          // ── Locate SVS source directory ───────────────────────────
          const svsPath = findStandardValueSetsDirectory(sfpmPackage.packageDirectory);
          if (!svsPath) {
            logger?.warn(`StandardValueSet: package reports ${svsList.length} SVS component(s) but `
              + `no standardValueSets directory found for '${packageName}'`);
            return;
          }

          logger?.info(`StandardValueSet: deploying ${svsList.length} standard value set(s) for '${packageName}'`);

          // ── Deploy ────────────────────────────────────────────────
          const deployer = new StandardValueSetDeployer(connection, logger);
          const result = await deployer.deploy(svsPath, options?.valueSetNames);

          if (!result.success) {
            throw new Error(`StandardValueSet: deployment failed for '${packageName}' `
              + `(${result.componentsDeployed}/${result.componentsTotal} deployed)`);
          }
        },
        operation: 'install',
        timing: 'post',
      },
    ],

    name: 'standard-value-set',
  };
}

// ============================================================================
// Helpers
// ============================================================================

function resolveConnection(
  context: HookContext,
  logger?: Logger,
): Connection | undefined {
  const {org} = context;

  if (org instanceof Org) {
    return org.getConnection();
  }

  logger?.debug('StandardValueSet: context.org is not an Org instance');
  return undefined;
}

/**
 * Walk upwards through common source-format layouts to find the
 * `standardValueSets` directory within a package.
 *
 * Typical layouts:
 * - `<packageDir>/standardValueSets/`
 * - `<packageDir>/main/default/standardValueSets/`
 */
function findStandardValueSetsDirectory(packageDirectory?: string): string | undefined {
  if (!packageDirectory) return undefined;

  const candidates = [
    join(packageDirectory, 'standardValueSets'),
    join(packageDirectory, 'main', 'default', 'standardValueSets'),
  ];

  return candidates.find(p => existsSync(p));
}
