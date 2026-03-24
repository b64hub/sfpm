import type {Logger} from '@b64/sfpm-core';
import type {Connection} from '@salesforce/core';

import {escapeSOQL} from '@b64/sfpm-core';

import type {FieldTrackingResult, FieldTrackingType} from './types.js';

// ============================================================================
// Constants
// ============================================================================

/** Maximum number of metadata components per read/update call (Metadata API limit). */
const METADATA_BATCH_SIZE = 10;

/** Tracking-type-specific configuration. */
const TRACKING_CONFIG = {
  feed: {
    logPrefix: 'FeedTracking',
    metadataProperty: 'trackFeedHistory',
    queryFilter: 'IsFeedEnabled = true',
  },
  history: {
    logPrefix: 'FieldHistoryTracking',
    metadataProperty: 'trackHistory',
    queryFilter: 'IsFieldHistoryTracked = true',
  },
} as const;

// ============================================================================
// Query Result Types
// ============================================================================

interface FieldDefinitionRecord {
  EntityDefinition: {QualifiedApiName: string};
  QualifiedApiName: string;
}

// ============================================================================
// FieldTrackingEnabler
// ============================================================================

/**
 * Enables field tracking (history or feed) on custom fields in a
 * Salesforce org.
 *
 * The enabler:
 * 1. Queries the org to find which fields already have tracking enabled
 * 2. Filters out already-enabled fields
 * 3. Reads the remaining field metadata from the org via the Metadata API
 * 4. Sets the tracking property to `true` on each field
 * 5. Updates the metadata back to the org
 *
 * Fields are processed in batches of {@link METADATA_BATCH_SIZE} to
 * respect Metadata API limits.
 */
export class FieldTrackingEnabler {
  private readonly config: typeof TRACKING_CONFIG[FieldTrackingType];

  constructor(
    private readonly connection: Connection,
    private readonly trackingType: FieldTrackingType,
    private readonly logger?: Logger,
  ) {
    this.config = TRACKING_CONFIG[trackingType];
  }

  /**
   * Enable tracking on the specified fields.
   *
   * @param qualifiedFieldNames - Field API names in `Object.Field` format
   *   (e.g., `['Account.MyField__c', 'Contact.Status__c']`)
   * @returns Result summary with counts of enabled and skipped fields
   */
  async enableTracking(qualifiedFieldNames: string[]): Promise<FieldTrackingResult> {
    if (qualifiedFieldNames.length === 0) {
      return {fieldsEnabled: 0, fieldsSkipped: 0, success: true};
    }

    // 1. Extract unique object names for the SOQL IN clause
    const objectNames = [...new Set(qualifiedFieldNames.map(f => f.split('.')[0]))];

    // 2. Query org for fields that already have tracking enabled
    const alreadyEnabled = await this.queryEnabledFields(objectNames);
    this.logger?.debug(`${this.config.logPrefix}: ${alreadyEnabled.size} field(s) already tracked`);

    // 3. Filter to fields that still need enabling
    const fieldsToEnable = qualifiedFieldNames.filter(f => !alreadyEnabled.has(f));

    if (fieldsToEnable.length === 0) {
      this.logger?.debug(`${this.config.logPrefix}: all fields already have tracking enabled`);
      return {
        fieldsEnabled: 0,
        fieldsSkipped: qualifiedFieldNames.length,
        success: true,
      };
    }

    this.logger?.info(`${this.config.logPrefix}: enabling tracking on ${fieldsToEnable.length} field(s)`);

    // 4. Read → modify → update in batches
    const enabledCount = await this.updateFields(fieldsToEnable);

    return {
      fieldsEnabled: enabledCount,
      fieldsSkipped: qualifiedFieldNames.length - fieldsToEnable.length,
      success: true,
    };
  }

  // --------------------------------------------------------------------------
  // Query
  // --------------------------------------------------------------------------

  /**
   * Process a single batch of fields: read from org, enable tracking, update.
   */
  private async processBatch(fieldNames: string[]): Promise<number> {
    // Read current metadata from org
    const metadata = await this.connection.metadata.read('CustomField', fieldNames);
    const fields = (Array.isArray(metadata) ? metadata : [metadata]) as Array<Record<string, unknown>>;

    // Filter out fields that weren't found (read returns stubs for missing fields)
    const validFields = fields.filter((f): f is Record<string, unknown> & {fullName: string} =>
      f !== null && typeof f === 'object' && typeof f.fullName === 'string' && f.fullName.length > 0);

    if (validFields.length === 0) {
      this.logger?.debug(`${this.config.logPrefix}: no fields found in org for this batch`);
      return 0;
    }

    // Enable tracking on each field
    for (const field of validFields) {
      field[this.config.metadataProperty] = true;
    }

    // Update in org
    const results = await this.connection.metadata.update('CustomField', validFields as any);
    const updateResults = Array.isArray(results) ? results : [results];

    let count = 0;
    for (const result of updateResults) {
      if (result.success) {
        this.logger?.debug(`${this.config.logPrefix}: enabled on '${result.fullName}'`);
        count++;
      } else {
        const errors = 'errors' in result
          ? formatSaveErrors((result as any).errors)
          : 'Unknown error';
        this.logger?.warn(`${this.config.logPrefix}: failed on '${result.fullName}': ${errors}`);
      }
    }

    return count;
  }

  // --------------------------------------------------------------------------
  // Read → Modify → Update
  // --------------------------------------------------------------------------

  /**
   * Query the org for fields that already have tracking enabled on the
   * specified objects.
   */
  private async queryEnabledFields(objectNames: string[]): Promise<Set<string>> {
    const inClause = objectNames.map(n => `'${escapeSOQL(n)}'`).join(', ');
    const query = 'SELECT QualifiedApiName, EntityDefinition.QualifiedApiName '
      + `FROM FieldDefinition WHERE ${this.config.queryFilter} `
      + `AND EntityDefinitionId IN (${inClause})`;

    this.logger?.trace(`${this.config.logPrefix}: ${query}`);

    const result = await this.connection.query<FieldDefinitionRecord>(query);
    const enabled = new Set<string>();

    for (const record of result.records) {
      enabled.add(`${record.EntityDefinition.QualifiedApiName}.${record.QualifiedApiName}`);
    }

    return enabled;
  }

  /**
   * Read field metadata from the org, enable tracking, and update.
   * Processes in batches to respect Metadata API limits.
   */
  private async updateFields(fieldsToEnable: string[]): Promise<number> {
    let enabledCount = 0;

    for (let i = 0; i < fieldsToEnable.length; i += METADATA_BATCH_SIZE) {
      const batch = fieldsToEnable.slice(i, i + METADATA_BATCH_SIZE);
      this.logger?.debug(`${this.config.logPrefix}: processing batch ${Math.floor(i / METADATA_BATCH_SIZE) + 1} `
        + `(${batch.length} field(s))`);

      // eslint-disable-next-line no-await-in-loop
      enabledCount += await this.processBatch(batch);
    }

    return enabledCount;
  }
}

// ============================================================================
// Helpers
// ============================================================================

function formatSaveErrors(errors: unknown): string {
  if (!errors) return 'Unknown error';

  const errorList = Array.isArray(errors) ? errors : [errors];
  return errorList
  .map((e: any) => e.message ?? String(e))
  .join('; ');
}
