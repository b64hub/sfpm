// ============================================================================
// Plugin Options
// ============================================================================

/**
 * Configuration options for the profile lifecycle hooks.
 */
/**
 * Controls how profile permissions are scoped before deployment.
 *
 * - `'source'` — scope to package source metadata only (default)
 * - `'org'`    — scope to source + org metadata (requires a `Connection` in hook context)
 * - `'none'`   — skip scoping entirely; profile passes through unchanged
 */
export type ProfileScope = 'none' | 'org' | 'source';

export interface ProfileHooksOptions {
  /**
   * Remove login hours from profiles.
   * @default false
   */
  removeLoginHours?: boolean;

  /**
   * Remove login IP ranges from profiles.
   * @default false
   */
  removeLoginIpRanges?: boolean;

  /**
   * Remove user permissions that are not explicitly assigned.
   * @default false
   */
  removeUnassignedUserPermissions?: boolean;

  /**
   * Controls how profile permissions are scoped.
   *
   * When set to `'source'` or `'org'`, the hook removes profile permission
   * entries that reference metadata absent from the allowed scope.
   *
   * - `'source'` — only keep permissions for metadata present in the package (default)
   * - `'org'`    — keep permissions for metadata in the package **or** the target org
   * - `'none'`   — do not scope; leave all permission entries intact
   *
   * @default 'source'
   */
  scope?: ProfileScope;
}

// ============================================================================
// Org Metadata Resolution
// ============================================================================

/**
 * Resolves metadata component names from a Salesforce org.
 *
 * Allows profile scoping to preserve permissions for standard
 * metadata that exists in the org but not in the package source.
 * When provided to `ProfileCleaner`, the cleaner checks both
 * source and org before removing a permission entry.
 *
 * The default implementation is `OrgMetadataResolver`, which
 * accepts a `Connection` from `@salesforce/core`.
 *
 * @example
 * ```typescript
 * const resolver = new OrgMetadataResolver(connection, logger);
 * const orgObjects = await resolver.getOrgComponents('objectPermissions');
 * ```
 */
export interface OrgMetadataProvider {
  /**
   * Get component names that exist in the target org for the
   * specified profile section.
   *
   * @param section - Profile section key (e.g., 'classAccesses', 'objectPermissions')
   * @returns Set of component API names present in the org
   */
  getOrgComponents(section: string): Promise<Set<string>>;
}

// ============================================================================
// Profile XML Schema
// ============================================================================

/**
 * Represents a parsed Salesforce Profile XML document.
 *
 * Mirrors the Metadata API Profile type. Arrays may contain a single
 * element (xml2js/fast-xml-parser normalize these to arrays when
 * `isArray` is configured).
 *
 * @see https://developer.salesforce.com/docs/atlas.en-us.api_meta.meta/api_meta/meta_profile.htm
 */
export interface Profile {
  applicationVisibilities?: ApplicationVisibility[];
  classAccesses?: ProfileApexClassAccess[];
  custom?: boolean;
  customMetadataTypeAccesses?: CustomMetadataTypeAccess[];
  customPermissions?: ProfileCustomPermission[];
  customSettingAccesses?: CustomSettingAccess[];
  description?: string;
  externalDataSourceAccesses?: ProfileExternalDataSourceAccess[];
  fieldPermissions?: ProfileFieldLevelSecurity[];
  flowAccesses?: FlowAccess[];
  fullName?: string;
  layoutAssignments?: ProfileLayoutAssignment[];
  loginFlows?: ProfileLoginFlow[];
  loginHours?: ProfileLoginHours;
  loginIpRanges?: ProfileLoginIpRange[];
  objectPermissions?: ProfileObjectPermission[];
  pageAccesses?: ProfileApexPageAccess[];
  profileActionOverrides?: ProfileActionOverride[];
  recordTypeVisibilities?: RecordTypeVisibility[];
  tabVisibilities?: ProfileTabVisibility[];
  userLicense?: string;
  userPermissions?: ProfileUserPermission[];
}

// ============================================================================
// Profile Section Interfaces
// ============================================================================

export interface ApplicationVisibility {
  application: string;
  default?: boolean;
  visible: boolean;
}

export interface ProfileApexClassAccess {
  apexClass: string;
  enabled: boolean;
}

export interface ProfileCustomPermission {
  enabled: boolean;
  name: string;
}

export interface CustomMetadataTypeAccess {
  enabled: boolean;
  name: string;
}

export interface CustomSettingAccess {
  enabled: boolean;
  name: string;
}

export interface ProfileExternalDataSourceAccess {
  enabled: boolean;
  externalDataSource: string;
}

export interface ProfileFieldLevelSecurity {
  editable: boolean;
  field: string;
  hidden?: boolean;
  readable: boolean;
}

export interface FlowAccess {
  enabled: boolean;
  flow: string;
}

export interface ProfileLayoutAssignment {
  layout: string;
  recordType?: string;
}

export interface ProfileLoginFlow {
  flow?: string;
  flowType?: string;
  friendlyName?: string;
  uiLoginFlowType?: string;
  useLightningRuntime?: string;
  vfFlowPage?: string;
  vfFlowPageTitle?: string;
}

export interface ProfileLoginHours {
  weekdayEnd?: string;
  weekdayStart?: string;
}

export interface ProfileLoginIpRange {
  description?: string;
  endAddress: string;
  startAddress: string;
}

export interface ProfileObjectPermission {
  allowCreate: boolean;
  allowDelete: boolean;
  allowEdit: boolean;
  allowRead: boolean;
  modifyAllRecords: boolean;
  object: string;
  viewAllRecords: boolean;
}

export interface ProfileApexPageAccess {
  apexPage: string;
  enabled: boolean;
}

export interface ProfileActionOverride {
  actionName: string;
  content: string;
  formFactor: string;
  pageOrSobjectType: string;
  recordType?: string;
  type: string;
}

export interface RecordTypeVisibility {
  default?: boolean;
  personAccountDefault?: boolean;
  recordType: string;
  visible: boolean;
}

export interface ProfileTabVisibility {
  tab: string;
  visibility: string;
}

export interface ProfileUserPermission {
  enabled: boolean;
  name: string;
}

// ============================================================================
// Metadata Component Names
// ============================================================================

/**
 * Known metadata component types that can appear in profile sections.
 *
 * Each key maps to the profile section property that references it. Used by
 * `ProfileCleaner` to know which components to look up during scoping.
 */
export const PROFILE_SECTION_TO_METADATA_TYPE = {
  applicationVisibilities: 'CustomApplication',
  classAccesses: 'ApexClass',
  customMetadataTypeAccesses: 'CustomObject',
  customPermissions: 'CustomPermission',
  customSettingAccesses: 'CustomObject',
  externalDataSourceAccesses: 'ExternalDataSource',
  fieldPermissions: 'CustomField',
  flowAccesses: 'Flow',
  layoutAssignments: 'Layout',
  objectPermissions: 'CustomObject',
  pageAccesses: 'ApexPage',
  recordTypeVisibilities: 'RecordType',
  tabVisibilities: 'CustomTab',
} as const;

/**
 * Maps profile section keys to the property holding the component name reference.
 */
export const PROFILE_SECTION_NAME_FIELD: Record<string, string> = {
  applicationVisibilities: 'application',
  classAccesses: 'apexClass',
  customMetadataTypeAccesses: 'name',
  customPermissions: 'name',
  customSettingAccesses: 'name',
  externalDataSourceAccesses: 'externalDataSource',
  fieldPermissions: 'field',
  flowAccesses: 'flow',
  layoutAssignments: 'layout',
  objectPermissions: 'object',
  pageAccesses: 'apexPage',
  recordTypeVisibilities: 'recordType',
  tabVisibilities: 'tab',
};
