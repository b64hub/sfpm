import {
  HookContext, LifecycleHooks, type Logger, PackageType,
} from '@b64/sfpm-core';
import {Connection, Org} from '@salesforce/core';

import type {PicklistFieldData, PicklistHooksOptions, PicklistValue} from './types.js';

import {PicklistEnabler} from './picklist-enabler.js';

// ============================================================================
// Picklist Types (Metadata API source XML shape)
// ============================================================================

const PICKLIST_XML_TYPES = new Set(['MultiselectPicklist', 'Picklist']);

/**
 * Parsed CustomField XML shape — only the properties the enabler reads.
 */
interface CustomFieldXml {
  fieldManageability?: unknown;
  type?: string;
  valueSet?: {
    valueSetDefinition?: {
      value?: Record<string, unknown> | Record<string, unknown>[];
    };
  };
}

/**
 * Minimal interface for the bits of `SourceComponent` we need.
 *
 * Avoids importing `@salesforce/source-deploy-retrieve` in the hooks
 * package — the real SourceComponent instances are supplied at runtime
 * by the orchestrator via the `SfpmMetadataPackage` domain model.
 */
interface SourceFieldLike {
  name: string;
  parent?: {fullName: string};
  parseXmlSync(): Record<string, unknown>;
}

/**
 * Shape of a package that exposes custom-field SourceComponents.
 * Satisfied by `SfpmMetadataPackage` (source / unlocked packages).
 */
interface PicklistCapablePackage {
  customFields: SourceFieldLike[];
  type: string;
}

// ============================================================================
// Public API
// ============================================================================

/**
 * Creates lifecycle hooks for enabling picklist values post-deployment.
 *
 * Registers a hook on `install:post` that synchronises picklist values
 * from the package source into the target org via the Tooling API.
 *
 * The hook reads picklist definitions from the package's
 * `ComponentSet` (exposed through `SfpmMetadataPackage.customFields`)
 * and compares them with the current org state. Only unlocked packages
 * are processed — source packages are deployed directly and don't need
 * this fixup.
 *
 * @param options - Hook configuration options
 * @returns A LifecycleHooks instance to pass to `defineConfig({ hooks: [...] })`
 *
 * @example
 * ```typescript
 * // sfpm.config.ts
 * import { defineConfig } from '@b64/sfpm-core';
 * import { picklistHooks } from '@b64/sfpm-hooks';
 *
 * export default defineConfig({
 *   hooks: [
 *     picklistHooks({ activationStrategy: 'all' }),
 *   ],
 * });
 * ```
 */
export function picklistHooks(options?: PicklistHooksOptions): LifecycleHooks {
  return {
    hooks: [
      {
        async handler(context: HookContext) {
          const {logger, packageName} = context;

          // ── Guard: only process unlocked packages ──────────────────
          const sfpmPackage = context.sfpmPackage as PicklistCapablePackage | undefined;

          if (!sfpmPackage || String(sfpmPackage.type) !== PackageType.Unlocked) {
            logger?.debug(`Picklist: skipping '${packageName}' (not an unlocked package)`);
            return;
          }

          // ── Guard: need an org connection ──────────────────────────
          const connection = resolveConnection(context, logger);
          if (!connection) {
            logger?.warn(`Picklist: no org connection available for '${packageName}', skipping`);
            return;
          }

          // ── Extract picklist field data from the package model ─────
          const fields = extractPicklistFields(sfpmPackage, options?.fieldNames, logger);

          if (fields.length === 0) {
            logger?.debug(`Picklist: no picklist fields found in '${packageName}'`);
            return;
          }

          logger?.info(`Picklist: processing ${fields.length} picklist field(s) for '${packageName}'`);

          // ── Enable / sync picklists ────────────────────────────────
          const enabler = new PicklistEnabler(connection, options, logger);
          const updatedCount = await enabler.enablePicklists(fields);

          if (updatedCount > 0) {
            logger?.info(`Picklist: updated ${updatedCount} picklist(s) for '${packageName}'`);
          } else {
            logger?.debug(`Picklist: all picklists for '${packageName}' are already in sync`);
          }
        },
        operation: 'install',
        timing: 'post',
      },
    ],

    name: 'picklist',
  };
}

// ============================================================================
// Helpers
// ============================================================================

/**
 * Resolve a Salesforce {@link Connection} from the hook context.
 *
 * The orchestrator is expected to place an `Org` instance on `context.org`.
 */
function resolveConnection(
  context: HookContext,
  logger?: Logger,
): Connection | undefined {
  const {org} = context;

  if (org instanceof Org) {
    return org.getConnection();
  }

  logger?.debug('Picklist: context.org is not an Org instance');
  return undefined;
}

/**
 * Walk the package's custom-field components, parse their XML, and return
 * normalised {@link PicklistFieldData} for every inline picklist definition.
 *
 * Skips:
 * - Fields that are not `Picklist` or `MultiselectPicklist`
 * - Fields managed by Custom Metadata Types (`fieldManageability`)
 * - Fields that use a Global Value Set reference (no inline `valueSetDefinition`)
 * - Fields whose parent object cannot be determined
 */
function extractPicklistFields(
  sfpmPackage: PicklistCapablePackage,
  fieldNames: string[] | undefined,
  logger?: Logger,
): PicklistFieldData[] {
  const customFields: SourceFieldLike[] = sfpmPackage.customFields ?? [];
  const fields: PicklistFieldData[] = [];
  const fieldNameSet = fieldNames?.length ? new Set(fieldNames) : undefined;

  for (const field of customFields) {
    let parsed: Record<string, unknown>;
    try {
      parsed = field.parseXmlSync();
    } catch {
      logger?.trace(`Picklist: failed to parse XML for field '${field.name}', skipping`);
      continue;
    }

    const customField = parsed?.CustomField as CustomFieldXml | undefined;
    if (!customField) continue;

    // Only process Picklist / MultiselectPicklist types
    if (!customField.type || !PICKLIST_XML_TYPES.has(customField.type)) continue;

    // Skip custom-metadata-type picklists
    if (customField.fieldManageability) continue;

    // Must have an inline value set definition (not a Global Value Set ref)
    if (!customField.valueSet?.valueSetDefinition) continue;

    const objectName = field.parent?.fullName;
    if (!objectName) continue;

    // Apply optional field-name filter
    const qualifiedName = `${objectName}.${field.name}`;
    if (fieldNameSet && !fieldNameSet.has(qualifiedName)) continue;

    const sourceValues = normaliseSourceValues(customField.valueSet.valueSetDefinition.value);

    if (sourceValues.length > 0) {
      fields.push({fieldName: field.name, objectName, sourceValues});
    }
  }

  return fields;
}

/**
 * Normalise the `value` property from a source XML `valueSetDefinition`.
 *
 * SDR may parse a single-element value set as a plain object rather than
 * an array — this function handles both shapes and filters out inactive
 * source values.
 */
function normaliseSourceValues(raw: Record<string, unknown> | Record<string, unknown>[] | undefined): PicklistValue[] {
  if (!raw) return [];

  const entries = Array.isArray(raw) ? raw : [raw];
  const values: PicklistValue[] = [];

  for (const entry of entries) {
    // Skip explicitly-inactive source values
    if (entry.isActive !== undefined && String(entry.isActive) === 'false') {
      continue;
    }

    const fullName = entry.fullName !== undefined && entry.fullName !== null
      ? decodeURI(String(entry.fullName))
      : undefined;
    const label = entry.label !== undefined && entry.label !== null
      ? decodeURI(String(entry.label))
      : undefined;

    if (!fullName) continue;

    values.push({
      default: entry.default === true || entry.default === 'true' ? 'true' : 'false',
      fullName,
      label: label ?? fullName,
    });
  }

  return values;
}
