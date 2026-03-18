// ── Browserforce ────────────────────────────────────────────────────────────
export {browserforceHooks} from './browserforce/browserforce-plugin.js';
export type {BrowserforceHooksOptions, BrowserforcePlanEntry} from './browserforce/types.js';
// ── Flow Activation ─────────────────────────────────────────────────────────
export {flowActivationHooks} from './flows/flow-activation-plugin.js';
export type {FlowActivationHooksOptions} from './flows/types.js';
// ── LWC Tailwind ────────────────────────────────────────────────────────────
export {lwcTailwindHooks} from './lwc/lwc-tailwind-plugin.js';

// ── LWC TypeScript ──────────────────────────────────────────────────────────
export {lwcTypescriptHooks} from './lwc/lwc-typescript-plugin.js';
export type {LwcTypescriptHooksOptions} from './lwc/types.js';

export type {LwcTailwindHooksOptions} from './lwc/types.js';
// ── Picklist ────────────────────────────────────────────────────────────────
export {picklistHooks} from './picklist/picklist-plugin.js';

export type {PicklistHooksOptions} from './picklist/types.js';
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
export type {ScriptDefinition, ScriptHooksOptions, ScriptType} from './scripts/types.js';

// ── Standard Value Set ──────────────────────────────────────────────────────
export {standardValueSetHooks} from './standard-value-set/standard-value-set-plugin.js';
export type {StandardValueSetHooksOptions} from './standard-value-set/types.js';
