/**
 * Configuration options for the profile lifecycle hooks.
 */
export interface ProfileHooksOptions {
  /**
   * Enable profile reconciliation — removes profile permissions that don't
   * correspond to metadata in the package being deployed.
   * @default true
   */
  reconcile?: boolean;

  /**
   * Remove user permissions that are not explicitly assigned.
   * @default false
   */
  removeUnassignedUserPermissions?: boolean;

  /**
   * Remove login IP ranges from profiles.
   * @default false
   */
  removeLoginIpRanges?: boolean;

  /**
   * Remove login hours from profiles.
   * @default false
   */
  removeLoginHours?: boolean;
}
