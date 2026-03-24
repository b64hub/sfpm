// ── Browserforce ────────────────────────────────────────────────────────────
export {browserforceHooks} from './browserforce/browserforce-plugin.js';
export type {BrowserforceHooksOptions, BrowserforcePlanEntry} from './browserforce/types.js';

// ── Feed Tracking ───────────────────────────────────────────────────────────
export {feedTrackingHooks} from './fields/feed-tracking-plugin.js';

export {fieldHistoryTrackingHooks} from './fields/field-history-tracking-plugin.js';
// ── Field History Tracking ──────────────────────────────────────────────────
export {FieldTrackingEnabler} from './fields/field-tracking-enabler.js';
export type {
  FeedTrackingHooksOptions, FieldHistoryTrackingHooksOptions, FieldTrackingResult, FieldTrackingType,
} from './fields/types.js';

export {flowActivationHooks} from './flows/flow-activation-plugin.js';
// ── Flow Activation ─────────────────────────────────────────────────────────
export {FlowActivator} from './flows/flow-activator.js';
export type {FlowActivationHooksOptions, FlowDefinitionRecord, PackageFlowEntry} from './flows/types.js';
// ── LWC Tailwind ────────────────────────────────────────────────────────────
export {lwcTailwindHooks} from './lwc/lwc-tailwind-plugin.js';

// ── LWC TypeScript ──────────────────────────────────────────────────────────
export {lwcTypescriptHooks} from './lwc/lwc-typescript-plugin.js';
export type {LwcTypescriptHooksOptions} from './lwc/types.js';

export type {LwcTailwindHooksOptions} from './lwc/types.js';
// ── Permission Set ──────────────────────────────────────────────────────────
export {PermissionSetAssigner} from './permissionset/permset-assigner.js';
export {permissionSetHooks} from './permissionset/permset-plugin.js';

export type {PermissionSetHooksOptions, PermSetAssignmentEntry, PermSetAssignmentResult} from './permissionset/types.js';

// ── Picklist ────────────────────────────────────────────────────────────────
export {PicklistEnabler} from './picklist/picklist-enabler.js';
export {picklistHooks} from './picklist/picklist-plugin.js';
export type {PicklistFieldData, PicklistHooksOptions, PicklistValue} from './picklist/types.js';

// ── Profiles ────────────────────────────────────────────────────────────────
export {OrgMetadataResolver} from './profiles/org-metadata-resolver.js';

export {collectPackageMetadata, findProfilesDirectory, ProfileCleaner} from './profiles/profile-cleaner.js';
export {profileHooks} from './profiles/profile-plugin.js';

export {
  buildProfileXml, parseProfileXml, readProfileXml, writeProfileXml,
} from './profiles/profile-xml.js';
export type {
  ApplicationVisibility,
  CustomMetadataTypeAccess,
  CustomSettingAccess,
  FlowAccess,
  OrgMetadataProvider,
  Profile,
  ProfileActionOverride,
  ProfileApexClassAccess,
  ProfileApexPageAccess,
  ProfileCustomPermission,
  ProfileExternalDataSourceAccess,
  ProfileFieldLevelSecurity,
  ProfileHooksOptions,
  ProfileLayoutAssignment,
  ProfileLoginFlow,
  ProfileLoginHours,
  ProfileLoginIpRange,
  ProfileObjectPermission,
  ProfileScope,
  ProfileTabVisibility,
  ProfileUserPermission,
  RecordTypeVisibility,
} from './profiles/types.js';

// ── Scripts ─────────────────────────────────────────────────────────────────
export {scriptHooks} from './scripts/script-plugin.js';
export {ScriptRunner} from './scripts/script-runner.js';
export type {ScriptDefinition, ScriptHooksOptions, ScriptType} from './scripts/types.js';

// ── Standard Value Set ──────────────────────────────────────────────────────
export {StandardValueSetDeployer} from './standard-value-set/standard-value-set-deployer.js';
export {standardValueSetHooks} from './standard-value-set/standard-value-set-plugin.js';
export type {StandardValueSetDeployResult, StandardValueSetHooksOptions} from './standard-value-set/types.js';
