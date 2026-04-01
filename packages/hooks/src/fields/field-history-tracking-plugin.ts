import {
  HookContext, LifecycleHooks, type Logger,
} from '@b64/sfpm-core';
import {Org} from '@salesforce/core';

import type {FieldHistoryTrackingHooksOptions} from './types.js';

import {FieldTrackingEnabler} from './field-tracking-enabler.js';

// ============================================================================
// Source Component Contracts
// ============================================================================

/**
 * Minimal interface for a package that exposes field history tracking data.
 * Satisfied by `SfpmMetadataPackage`.
 */
interface FhtCapablePackage {
  fhtFields: string[];
  type: string;
}

// ============================================================================
// Public API
// ============================================================================

/**
 * Creates lifecycle hooks for enabling field history tracking post-deployment.
 *
 * Registers a hook on `install:post` that ensures `trackHistory` is enabled
 * on custom fields declared in the package source. The hook:
 *
 * 1. Reads the list of fields with `trackHistory=true` from the package
 *    metadata (populated during build by the FHT analyzer)
 * 2. Queries the target org to find which fields already have tracking enabled
 * 3. Reads the remaining field metadata from the org via the Metadata API
 * 4. Enables `trackHistory` on each field and updates the org
 *
 * Skips scratch orgs by default, since field history tracking behaves
 * differently in scratch org environments.
 *
 * @param options - Hook configuration options
 * @returns A LifecycleHooks instance to pass to `defineConfig({ hooks: [...] })`
 *
 * @example
 * ```typescript
 * // sfpm.config.ts
 * import { defineConfig } from '@b64/sfpm-core';
 * import { fieldHistoryTrackingHooks } from '@b64/sfpm-hooks';
 *
 * export default defineConfig({
 *   hooks: [
 *     fieldHistoryTrackingHooks(),
 *   ],
 * });
 * ```
 */
export function fieldHistoryTrackingHooks(options?: FieldHistoryTrackingHooksOptions): LifecycleHooks {
  const skipScratch = options?.skipScratchOrgs ?? true;

  return {
    hooks: [
      {
        async handler(context: HookContext) {
          const {logger, packageName} = context;

          // ── Guard: need an org ────────────────────────────────────
          const org = resolveOrg(context, logger);
          if (!org) {
            logger?.warn(`FieldHistoryTracking: no org connection for '${packageName}', skipping`);
            return;
          }

          // ── Guard: skip scratch orgs ──────────────────────────────
          if (skipScratch && await org.determineIfScratch()) {
            logger?.debug(`FieldHistoryTracking: skipping '${packageName}' (scratch org)`);
            return;
          }

          // ── Guard: check for FHT fields in package ────────────────
          const sfpmPackage = context.sfpmPackage as FhtCapablePackage | undefined;
          const fhtFields = sfpmPackage?.fhtFields ?? [];

          if (fhtFields.length === 0) {
            logger?.debug(`FieldHistoryTracking: no tracked fields in '${packageName}'`);
            return;
          }

          logger?.info(`FieldHistoryTracking: processing ${fhtFields.length} field(s) for '${packageName}'`);

          // ── Enable tracking ───────────────────────────────────────
          const enabler = new FieldTrackingEnabler(org.getConnection(), 'history', logger);
          const result = await enabler.enableTracking(fhtFields);

          if (result.fieldsEnabled > 0) {
            logger?.info(`FieldHistoryTracking: enabled tracking on ${result.fieldsEnabled} field(s) for '${packageName}'`);
          } else {
            logger?.debug(`FieldHistoryTracking: all fields for '${packageName}' already have tracking enabled`);
          }
        },
        operation: 'install',
        timing: 'post',
      },
    ],

    name: 'field-history-tracking',
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

  logger?.debug('FieldHistoryTracking: context.org is not an Org instance');
  return undefined;
}
