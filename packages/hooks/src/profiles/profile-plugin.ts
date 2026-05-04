import {HookContext, LifecycleHooks, Logger} from '@b64/sfpm-core';
import {Org} from '@salesforce/core';

import type {ProfileHooksOptions} from './types.js';

import {OrgMetadataResolver} from './org-metadata-resolver.js';
import {collectPackageComponents, findProfilesDirectory, ProfileCleaner} from './profile-cleaner.js';

/**
 * Creates lifecycle hooks for profile cleaning and scoping.
 *
 * Registers a hook on `install:pre` that cleans profile XML files
 * before deployment. This removes permissions that reference metadata not
 * present in the allowed scope, preventing deployment failures.
 *
 * The scoping logic is migrated from
 * {@link https://github.com/flxbl-io/sfprofiles | sfprofiles} and adapted
 * to work as a standalone cleaner. When `scope` is `'org'` and a
 * `context.orgConnection` is present, the hook also queries the target org
 * for standard metadata — preserving permissions that reference components
 * not in the package source but present in the org.
 *
 * @param options - Hook configuration options
 * @returns A LifecycleHooks instance to pass to `defineConfig({ hooks: [...] })`
 *
 * @example
 * ```typescript
 * // sfpm.config.ts
 * import { defineConfig } from '@b64/sfpm-core';
 * import { profileHooks } from '@b64/sfpm-hooks';
 *
 * export default defineConfig({
 *   hooks: [
 *     profileHooks({ scope: 'source', removeLoginIpRanges: true }),
 *   ],
 * });
 * ```
 */
export function profileHooks(options?: ProfileHooksOptions): LifecycleHooks {
  return {
    hooks: [
      {
        async handler(context: HookContext) {
          const {logger, packageName, packagePath} = context;
          const cleaner = new ProfileCleaner(options, logger);

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

          // Build the metadata component set from the package source
          const packageComponents = await collectPackageComponents(packagePath);
          logger?.debug(`Profiles: collected components from ${packageComponents.size} section(s)`);

          // Create org resolver if scope is 'org' and a Salesforce connection is available
          const scope = options?.scope ?? 'source';
          let orgResolver: OrgMetadataResolver | undefined;

          if (scope === 'org') {
            orgResolver = await resolveOrgMetadata(context, logger);
            if (orgResolver) {
              logger?.info('Profiles: org connection available — scoping against source + org');
            } else {
              logger?.warn('Profiles: scope is \'org\' but no connection available — falling back to source only');
            }
          } else if (scope === 'source') {
            logger?.debug('Profiles: scoping against source only');
          } else {
            logger?.debug('Profiles: scoping disabled');
          }

          // Run the cleaner
          const cleaned = await cleaner.cleanProfiles(profilesDir, packageComponents, orgResolver);

          if (cleaned.length > 0) {
            logger?.info(`Profiles: cleaned ${cleaned.length} profile(s) for '${packageName}'`);
          } else {
            logger?.debug(`Profiles: no profiles needed cleaning for '${packageName}'`);
          }
        },
        operation: 'install',
        timing: 'pre',
      },
    ],

    name: 'profiles',
  };
}

// ============================================================================
// Org Connection Resolution
// ============================================================================

/**
 * Attempt to create an org metadata resolver from the hook context.
 *
 * Resolution order:
 * 1. `context.targetOrg` — alias or username string; creates a new Org connection
 * 2. `context.org` — pre-built `Org` instance (backward compat with orchestrator)
 *
 * Returns `undefined` when no org information is available.
 */
async function resolveOrgMetadata(
  context: HookContext,
  logger?: Logger,
): Promise<OrgMetadataResolver | undefined> {
  // Prefer the typed targetOrg alias/username
  if (context.targetOrg) {
    try {
      const org = await Org.create({aliasOrUsername: context.targetOrg});
      return new OrgMetadataResolver(org.getConnection(), logger);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger?.debug(`Profiles: failed to connect to '${context.targetOrg}': ${message}`);
      return undefined;
    }
  }

  // Fall back to pre-built Org instance on context
  const {org} = context;
  if (org instanceof Org) {
    return new OrgMetadataResolver(org.getConnection(), logger);
  }

  return undefined;
}
