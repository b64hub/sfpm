// ============================================================================
// Picklist Hook Options
// ============================================================================

/**
 * Configuration options for the picklist enablement lifecycle hook.
 *
 * After an unlocked package version is installed, custom picklist values
 * may be inactive in the target org. This hook synchronises picklist
 * values from the package source into the org via the Tooling API.
 */
export interface PicklistHooksOptions {
  /**
   * How to reconcile source and org picklist values.
   *
   * - `'all'`  — replace the org value set with the source values (default).
   *              Inactive org values are discarded; the source becomes the
   *              single source of truth.
   * - `'new'`  — only add values that exist in source but not yet in the org.
   *              Existing org values are left untouched.
   *
   * @default 'all'
   */
  activationStrategy?: 'all' | 'new';

  /**
   * Specific picklist fields to target, as `Object.Field` API names.
   * When omitted, all picklist fields included in the package are processed.
   *
   * @example ['Account.Industry', 'Case.Priority']
   */
  fieldNames?: string[];
}

// ============================================================================
// Picklist Value Types
// ============================================================================

/**
 * A normalised picklist value used for source ↔ org comparison.
 *
 * Both source XML and org Tooling API responses are mapped into this
 * shape so that comparison logic stays consistent.
 */
export interface PicklistValue {
  /** Whether this value is the default selection (`'true'` or `'false'`). */
  default: string;
  /** The unique API name (developer name) of the value. */
  fullName: string;
  /** The user-facing label. */
  label: string;
}

/**
 * Extracted picklist field data ready for org synchronisation.
 */
export interface PicklistFieldData {
  /** API name of the custom field (e.g. `'Status__c'`). */
  fieldName: string;
  /** API name of the parent object (e.g. `'Account'`). */
  objectName: string;
  /** Normalised picklist values from the source XML. */
  sourceValues: PicklistValue[];
}

// ============================================================================
// Tooling API Response Types
// ============================================================================

/**
 * A single value entry inside a Tooling API `CustomField.Metadata.valueSet`.
 */
export interface ToolingPicklistValue {
  default: boolean;
  isActive: boolean;
  label: string;
  valueName: string;
}

/**
 * Shape of the Tooling API `CustomField` record that we read and update.
 *
 * Only the properties the enabler touches are declared; the real object
 * contains many more fields.
 */
export interface ToolingCustomField {
  attributes: {type: string; url: string};
  FullName: string;
  Id: string;
  Metadata: {
    valueSet?: {
      valueSetDefinition?: {
        value: ToolingPicklistValue[];
      };
      valueSettings?: unknown[];
    };
  };
}
