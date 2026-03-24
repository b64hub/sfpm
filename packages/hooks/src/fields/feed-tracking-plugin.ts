import {
  HookContext, LifecycleHooks, type Logger,
} from '@b64/sfpm-core';
import {Org} from '@salesforce/core';

import type {FeedTrackingHooksOptions} from './types.js';

import {FieldTrackingEnabler} from './field-tracking-enabler.js';

// ============================================================================
// Source Component Contracts
// ============================================================================

/**
 * Minimal interface for a package that exposes feed tracking data.
 * Satisfied by `SfpmMetadataPackage`.
 */
interface FtCapablePackage {
  ftFields: string[];
  type: string;
}

// ============================================================================
// Public API
// ============================================================================

/**
 * Creates lifecycle hooks for enabling feed tracking post-deployment.
 *
 * Registers a hook on `install:post` that ensures `trackFeedHistory` is
 * enabled on custom fields declared in the package source. The hook:
 *
 * 1. Reads the list of fields with `trackFeedHistory=true` from the package
 *    metadata (populated during build by the FT analyzer)
 * 2. Queries the target org to find which fields already have feed tracking
 * 3. Reads the remaining field metadata from the org via the Metadata API
 * 4. Enables `trackFeedHistory` on each field and updates the org
 *
 * Skips scratch orgs by default, since feed tracking behaves differently
 * in scratch org environments.
 *
 * @param options - Hook configuration options
 * @returns A LifecycleHooks instance to pass to `defineConfig({ hooks: [...] })`
 *
 * @example
 * ```typescript
 * // sfpm.config.ts
 * import { defineConfig } from '@b64/sfpm-core';
 * import { feedTrackingHooks } from '@b64/sfpm-hooks';
 *
 * export default defineConfig({
 *   hooks: [
 *     feedTrackingHooks(),
 *   ],
 * });
 * ```
 */
export function feedTrackingHooks(options?: FeedTrackingHooksOptions): LifecycleHooks {
  const skipScratch = options?.skipScratchOrgs ?? true;

  return {
    hooks: [
      {
        async handler(context: HookContext) {
          const {logger, packageName} = context;

          // ── Guard: need an org ────────────────────────────────────
          const org = resolveOrg(context, logger);
          if (!org) {
            logger?.warn(`FeedTracking: no org connection for '${packageName}', skipping`);
            return;
          }

          // ── Guard: skip scratch orgs ──────────────────────────────
          if (skipScratch && await org.determineIfScratch()) {
            logger?.debug(`FeedTracking: skipping '${packageName}' (scratch org)`);
            return;
          }

          // ── Guard: check for FT fields in package ─────────────────
          const sfpmPackage = context.sfpmPackage as FtCapablePackage | undefined;
          const ftFields = sfpmPackage?.ftFields ?? [];

          if (ftFields.length === 0) {
            logger?.debug(`FeedTracking: no tracked fields in '${packageName}'`);
            return;
          }

          logger?.info(`FeedTracking: processing ${ftFields.length} field(s) for '${packageName}'`);

          // ── Enable tracking ───────────────────────────────────────
          const enabler = new FieldTrackingEnabler(org.getConnection(), 'feed', logger);
          const result = await enabler.enableTracking(ftFields);

          if (result.fieldsEnabled > 0) {
            logger?.info(`FeedTracking: enabled tracking on ${result.fieldsEnabled} field(s) for '${packageName}'`);
          } else {
            logger?.debug(`FeedTracking: all fields for '${packageName}' already have tracking enabled`);
          }
        },
        operation: 'install',
        timing: 'post',
      },
    ],

    name: 'feed-tracking',
  };
}

// ============================================================================
// Helpers
// ============================================================================

function resolveOrg(
  context: HookContext,
  logger?: Logger,
): Org | undefined {
  const {org} = context;

  if (org instanceof Org) {
    return org;
  }

  logger?.debug('FeedTracking: context.org is not an Org instance');
  return undefined;
}
