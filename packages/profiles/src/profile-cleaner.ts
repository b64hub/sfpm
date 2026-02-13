import {existsSync} from 'node:fs';
import {join} from 'node:path';

import {ProfileHooksOptions} from './types.js';

/**
 * Handles cleaning and reconciliation of Salesforce profile XML files.
 *
 * Profile reconciliation removes permission entries from profile XML that
 * don't correspond to metadata present in the package being deployed.
 * This prevents deployment failures caused by references to components
 * that don't exist in the target org.
 *
 * @remarks
 * This is a placeholder — the full implementation will be migrated from
 * an existing codebase. The public API surface is intentionally minimal
 * to establish the architecture before migration.
 */
export class ProfileCleaner {
  readonly options: Required<ProfileHooksOptions>;

  constructor(options?: ProfileHooksOptions) {
    this.options = {
      reconcile: options?.reconcile ?? true,
      removeLoginHours: options?.removeLoginHours ?? false,
      removeLoginIpRanges: options?.removeLoginIpRanges ?? false,
      removeUnassignedUserPermissions: options?.removeUnassignedUserPermissions ?? false,
    };
  }

  /**
   * Clean all profile files in the given directory.
   *
   * @param profilesDirectory - Absolute path to the profiles directory
   * @param _packageMetadata - Optional set of metadata component names for reconciliation
   */
  async cleanProfiles(
    profilesDirectory: string,
    _packageMetadata?: Set<string>,
  ): Promise<void> {
    if (!existsSync(profilesDirectory)) {
      return;
    }

    // TODO: migrate implementation
    throw new Error('ProfileCleaner.cleanProfiles is not yet implemented');
  }
}

/**
 * Find profile directories within a package's source path.
 *
 * Searches standard Salesforce directory structures for profile files.
 */
export function findProfilesDirectory(packagePath: string): string | undefined {
  const profilesDir = join(packagePath, 'profiles');
  if (existsSync(profilesDir)) {
    return profilesDir;
  }

  const defaultProfilesDir = join(packagePath, 'main', 'default', 'profiles');
  if (existsSync(defaultProfilesDir)) {
    return defaultProfilesDir;
  }

  return undefined;
}
