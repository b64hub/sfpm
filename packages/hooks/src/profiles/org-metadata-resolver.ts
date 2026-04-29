import type {Logger} from '@b64/sfpm-core';

import {Connection} from '@salesforce/core';

import type {OrgMetadataProvider} from './types.js';

import {PROFILE_SECTION_TO_METADATA_TYPE} from './types.js';

// ============================================================================
// OrgMetadataResolver
// ============================================================================

/**
 * Queries a Salesforce org for metadata component names used during
 * profile scoping.
 *
 * Caches results per profile section so repeated calls (e.g., across
 * multiple profile files) only query the org once.
 *
 * Used to preserve permissions for standard metadata that exists in the
 * org but is not part of the package source.
 *
 * @example
 * ```typescript
 * import { OrgMetadataResolver } from '@b64/sfpm-hooks';
 * import { Connection } from '@salesforce/core';
 *
 * const resolver = new OrgMetadataResolver(connection, logger);
 * const orgClasses = await resolver.getOrgComponents('classAccesses');
 * ```
 */
export class OrgMetadataResolver implements OrgMetadataProvider {
  private readonly cache = new Map<string, Set<string>>();

  constructor(
    private readonly connection: Connection,
    private readonly logger?: Logger,
  ) {}

  async getOrgComponents(section: string): Promise<Set<string>> {
    const cached = this.cache.get(section);
    if (cached) {
      return cached;
    }

    this.logger?.debug(`OrgResolver: querying org for '${section}' components`);

    let components: Set<string>;
    try {
      components = await this.queryComponents(section);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger?.warn(`OrgResolver: failed to query org for '${section}': ${message}`);
      components = new Set();
    }

    this.logger?.debug(`OrgResolver: found ${components.size} '${section}' components in org`);
    this.cache.set(section, components);
    return components;
  }

  // ==========================================================================
  // Query Dispatch
  // ==========================================================================

  /**
   * Route a section query to the appropriate Salesforce API call.
   *
   * Most metadata types use `Metadata.list()`, but some require
   * specialized queries (objects via describeGlobal, fields via
   * FieldDefinition SOQL, etc.).
   */
  private async queryComponents(section: string): Promise<Set<string>> {
    switch (section) {
    case 'fieldPermissions': {
      return this.queryFields();
    }

    case 'objectPermissions': {
      return this.queryObjects();
    }

    case 'recordTypeVisibilities': {
      return this.queryRecordTypes();
    }

    case 'tabVisibilities': {
      return this.queryTabs();
    }

    default: {
      return this.queryMetadataList(section);
    }
    }
  }

  // ==========================================================================
  // Specialized Queries
  // ==========================================================================

  /**
   * Query custom field definitions via the Metadata API.
   *
   * Returns qualified names in `Object.Field` format. Standard fields
   * are not returned — the profile cleaner's `isFieldKnown` check falls
   * back to the parent object in `objectPermissions` for those.
   *
   * Previous implementation used a SOQL query on `FieldDefinition`, but
   * that entity requires a filter on `EntityDefinitionId` or `DurableId`,
   * making an unfiltered global query impossible.
   */
  private async queryFields(): Promise<Set<string>> {
    const result = await this.connection.metadata.list([{type: 'CustomField'}]);
    return new Set(result.map(r => r.fullName));
  }

  /**
   * Query metadata components using the Metadata API `list()` method.
   * Maps the profile section key to the corresponding Salesforce metadata
   * type via {@link PROFILE_SECTION_TO_METADATA_TYPE}.
   */
  private async queryMetadataList(section: string): Promise<Set<string>> {
    const metadataType
      = PROFILE_SECTION_TO_METADATA_TYPE[section as keyof typeof PROFILE_SECTION_TO_METADATA_TYPE];

    if (!metadataType) {
      return new Set();
    }

    const result = await this.connection.metadata.list([{type: metadataType}]);
    return new Set(result.map(r => r.fullName));
  }

  /**
   * Query all SObject names via describeGlobal.
   * Returns both standard and custom objects.
   */
  private async queryObjects(): Promise<Set<string>> {
    const result = await this.connection.describeGlobal();
    return new Set(result.sobjects.map(s => s.name));
  }

  /**
   * Query RecordType definitions.
   * Returns qualified names in `Object.RecordType` format.
   */
  private async queryRecordTypes(): Promise<Set<string>> {
    interface RecordTypeRecord {
      DeveloperName: string;
      SobjectType: string;
    }

    const result = await this.connection.query<RecordTypeRecord>('SELECT DeveloperName, SobjectType FROM RecordType');

    return new Set(result.records.map(r => `${r.SobjectType}.${r.DeveloperName}`));
  }

  /**
   * Query tabs by combining TabDefinition SOQL (standard tabs) with
   * Metadata API list (custom tabs).
   */
  private async queryTabs(): Promise<Set<string>> {
    interface TabRecord {
      Name: string;
    }

    const tabResult = await this.connection.query<TabRecord>('SELECT Name FROM TabDefinition');

    const customTabs = await this.connection.metadata.list([{type: 'CustomTab'}]);

    const tabs = new Set(tabResult.records.map(r => r.Name));
    for (const tab of customTabs) {
      tabs.add(tab.fullName);
    }

    return tabs;
  }
}
