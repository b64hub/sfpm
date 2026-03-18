import type {Logger} from '@b64/sfpm-core';
import type {Connection} from '@salesforce/core';

import {escapeSOQL} from '@b64/sfpm-core';

import type {
  PicklistFieldData,
  PicklistHooksOptions,
  PicklistValue,
  ToolingCustomField,
} from './types.js';

// ============================================================================
// Constants
// ============================================================================

const FIELD_DEFINITION_QUERY
  = "SELECT Id FROM FieldDefinition WHERE EntityDefinition.QualifiedApiName = '{0}' AND QualifiedApiName = '{1}'";

// ============================================================================
// PicklistEnabler
// ============================================================================

/**
 * Synchronises picklist values from source metadata into a Salesforce org
 * using the Tooling API.
 *
 * Each field is processed individually:
 * 1. Query `FieldDefinition` to locate the Tooling API `CustomField` record.
 * 2. Read the current value set from the org.
 * 3. Compare source and org values.
 * 4. If different, push the reconciled value set back via
 *    `conn.tooling.sobject('CustomField').update()`.
 *
 * Background-job collisions (common with Tooling API picklist updates)
 * are automatically retried up to {@link MAX_RETRIES} times.
 */
export class PicklistEnabler {
  private readonly strategy: 'all' | 'new';

  constructor(
    private readonly connection: Connection,
    private readonly options?: PicklistHooksOptions,
    private readonly logger?: Logger,
  ) {
    this.strategy = options?.activationStrategy ?? 'all';
  }

  /**
   * Process a list of picklist fields — compare source with org and update
   * where required.
   *
   * @returns The number of fields actually updated.
   */
  async enablePicklists(fields: PicklistFieldData[]): Promise<number> {
    // Fields must be processed sequentially — the Tooling API does not
    // support concurrent picklist updates and will throw background-job
    // collisions if we parallelise.
    let updatedCount = 0;

    for (const field of fields) {
      // eslint-disable-next-line no-await-in-loop
      const updated = await this.processField(field);
      if (updated) updatedCount++;
    }

    return updatedCount;
  }

  // --------------------------------------------------------------------------
  // Field Processing
  // --------------------------------------------------------------------------

  /**
   * Two value sets are identical when they contain the same active values
   * (fullName + label + default) regardless of order.
   */
  private arePicklistsIdentical(orgValues: PicklistValue[], sourceValues: PicklistValue[]): boolean {
    if (orgValues.length !== sourceValues.length) return false;

    return orgValues.every(orgVal =>
      sourceValues.some(srcVal =>
        srcVal.fullName === orgVal.fullName
        && srcVal.label === orgVal.label
        && srcVal.default === orgVal.default));
  }

  /**
   * Extract active picklist values from a Tooling API CustomField record.
   *
   * Maps the org's `valueName` to our normalised `fullName` and converts
   * the boolean `default` flag to a string for consistent comparison.
   */
  private extractOrgValues(orgField: ToolingCustomField): PicklistValue[] {
    const rawValues = orgField.Metadata.valueSet?.valueSetDefinition?.value ?? [];

    return rawValues
    .filter(v => v.isActive !== false)
    .map(v => ({
      default: v.default === true ? 'true' : 'false',
      fullName: v.valueName,
      label: v.label,
    }));
  }

  /**
   * Locate the Tooling API CustomField record for a given object + field
   * using the FieldDefinition entity as an index.
   */
  private async getPicklistFromOrg(
    objectName: string,
    fieldName: string,
  ): Promise<ToolingCustomField | undefined> {
    const query = FIELD_DEFINITION_QUERY
    .replace('{0}', escapeSOQL(objectName))
    .replace('{1}', escapeSOQL(fieldName));

    const response = await this.connection.query<{attributes: {type: string; url: string}; Id: string;}>(query);

    if (!response.records?.length || !response.records[0].attributes) {
      return undefined;
    }

    // Extract the CustomField Tooling API Id from the FieldDefinition URL
    const attributeUrl = response.records[0].attributes.url;
    const fieldId = attributeUrl.slice(attributeUrl.lastIndexOf('.') + 1);

    const toolingRecords = await this.connection.tooling
    .sobject('CustomField')
    .find({Id: fieldId}) as unknown as ToolingCustomField[];

    return toolingRecords?.[0];
  }

  // --------------------------------------------------------------------------
  // Tooling API Operations
  // --------------------------------------------------------------------------

  private async processField(field: PicklistFieldData): Promise<boolean> {
    const qualifiedName = `${field.objectName}.${field.fieldName}`;

    this.logger?.trace(`Picklist: fetching ${qualifiedName} from org`);

    const orgField = await this.getPicklistFromOrg(field.objectName, field.fieldName);

    if (!orgField?.Metadata?.valueSet?.valueSetDefinition) {
      this.logger?.trace(`Picklist: ${qualifiedName} not found in target org, skipping`);
      return false;
    }

    const orgValues = this.extractOrgValues(orgField);

    if (this.strategy === 'all') {
      return this.syncAll(orgField, field.sourceValues, orgValues, qualifiedName);
    }

    return this.syncNew(orgField, field.sourceValues, orgValues, qualifiedName);
  }

  /**
   * Strategy `'all'`: replace the org value set entirely with source values.
   */
  private async syncAll(
    orgField: ToolingCustomField,
    sourceValues: PicklistValue[],
    orgValues: PicklistValue[],
    qualifiedName: string,
  ): Promise<boolean> {
    if (this.arePicklistsIdentical(orgValues, sourceValues)) {
      this.logger?.trace(`Picklist: ${qualifiedName} is identical to source, skipping`);
      return false;
    }

    await this.updatePicklist(orgField, sourceValues, qualifiedName);
    return true;
  }

  // --------------------------------------------------------------------------
  // Value Extraction & Comparison
  // --------------------------------------------------------------------------

  /**
   * Strategy `'new'`: only append values that exist in source but not in the org.
   */
  private async syncNew(
    orgField: ToolingCustomField,
    sourceValues: PicklistValue[],
    orgValues: PicklistValue[],
    qualifiedName: string,
  ): Promise<boolean> {
    const orgNames = new Set(orgValues.map(v => v.fullName));
    const newValues = sourceValues.filter(v => !orgNames.has(v.fullName));

    if (newValues.length === 0) {
      this.logger?.trace(`Picklist: ${qualifiedName} has no new values to add, skipping`);
      return false;
    }

    // Merge: keep existing org values (active only), then append new ones
    const merged = [...orgValues, ...newValues];
    await this.updatePicklist(orgField, merged, qualifiedName);
    return true;
  }

  /**
   * Push an updated value set to the org via the Tooling API.
   *
   * Retries automatically when the org reports a background job collision.
   */
  private async updatePicklist(
    orgField: ToolingCustomField,
    values: PicklistValue[],
    qualifiedName: string,
  ): Promise<void> {
    // Build the update payload — replace the value set and clear valueSettings
    orgField.Metadata.valueSet!.valueSetDefinition!.value = values.map(v => ({
      default: v.default === 'true',
      isActive: true,
      label: v.label,
      valueName: v.fullName,
    }));
    orgField.Metadata.valueSet!.valueSettings = [];

    const payload = {
      attributes: orgField.attributes,
      FullName: orgField.FullName,
      Id: orgField.Id,
      Metadata: orgField.Metadata,
    };

    await this.connection.tooling.sobject('CustomField').update(payload as {[key: string]: unknown; Id: string;});

    this.logger?.info(`Picklist: updated ${qualifiedName}`);
  }
}
