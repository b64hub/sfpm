import {XMLBuilder, XMLParser} from 'fast-xml-parser';
import {readFile, writeFile} from 'node:fs/promises';

import type {Profile} from './types.js';

// ============================================================================
// Constants
// ============================================================================

const PROFILE_NAMESPACE = 'http://soap.sforce.com/2006/04/metadata';

/**
 * Profile properties that must remain scalar (not wrapped in an array)
 * after parsing and before writing.
 */
const SCALAR_PROPERTIES = new Set([
  'custom',
  'description',
  'fullName',
  'userLicense',
]);

/**
 * Profile properties that are always arrays in the schema.
 * fast-xml-parser needs to know these upfront to avoid collapsing
 * single-element arrays into scalars.
 */
const ARRAY_PROPERTIES = new Set([
  'applicationVisibilities',
  'classAccesses',
  'customMetadataTypeAccesses',
  'customPermissions',
  'customSettingAccesses',
  'externalDataSourceAccesses',
  'fieldPermissions',
  'flowAccesses',
  'layoutAssignments',
  'loginFlows',
  'loginIpRanges',
  'objectPermissions',
  'pageAccesses',
  'profileActionOverrides',
  'recordTypeVisibilities',
  'tabVisibilities',
  'userPermissions',
]);

// ============================================================================
// Parser / Builder instances
// ============================================================================

function createParser(): XMLParser {
  return new XMLParser({
    ignoreAttributes: true,
    isArray(_name: string, jpath: string) {
      // Only arrayify at the "Profile.<section>" level (depth 2),
      // not deeper child properties like "Profile.classAccesses.apexClass"
      const parts = jpath.split('.');
      if (parts.length === 2) {
        return ARRAY_PROPERTIES.has(parts[1]);
      }

      return false;
    },
    parseTagValue: true,
    trimValues: true,
  });
}

function createBuilder(): XMLBuilder {
  return new XMLBuilder({
    format: true,
    ignoreAttributes: false,
    indentBy: '    ',
    processEntities: false,
    suppressBooleanAttributes: true,
    suppressEmptyNode: true,
  });
}

// ============================================================================
// Public API
// ============================================================================

/**
 * Parse a Salesforce Profile XML string into a typed {@link Profile} object.
 *
 * Boolean values (`true`/`false` strings) are automatically converted to
 * native booleans. Array properties are always returned as arrays, even if
 * the XML contains a single element.
 *
 * @param xml - Raw XML string content of a `.profile-meta.xml` file
 * @returns Parsed Profile object
 */
export function parseProfileXml(xml: string): Profile {
  const parser = createParser();
  const parsed = parser.parse(xml);

  const raw = parsed?.Profile;
  if (!raw) {
    return {};
  }

  return normalizeProfile(raw);
}

/**
 * Read a profile XML file from disk and parse it into a {@link Profile} object.
 *
 * @param filePath - Absolute path to the `.profile-meta.xml` file
 * @returns Parsed Profile object
 */
export async function readProfileXml(filePath: string): Promise<Profile> {
  const content = await readFile(filePath, 'utf8');
  return parseProfileXml(content);
}

/**
 * Serialize a {@link Profile} object back to Salesforce-compatible XML.
 *
 * Produces well-formed XML with the Metadata API namespace and `<?xml ...?>`
 * declaration. Empty arrays are omitted from output.
 *
 * @param profile - The Profile object to serialize
 * @returns XML string suitable for writing to a `.profile-meta.xml` file
 */
export function buildProfileXml(profile: Profile): string {
  // Remove empty arrays before serialization
  const cleaned: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(profile)) {
    if (Array.isArray(value) && value.length === 0) {
      continue;
    }

    if (value === undefined) {
      continue;
    }

    cleaned[key] = value;
  }

  const builder = createBuilder();
  const inner = builder.build({Profile: cleaned});

  // fast-xml-parser doesn't insert namespace attributes when ignoreAttributes
  // is false during build, so we inject it manually.
  const xmlDecl = '<?xml version="1.0" encoding="UTF-8"?>';
  const withNs = inner.replace(
    '<Profile>',
    `<Profile xmlns="${PROFILE_NAMESPACE}">`,
  );

  return `${xmlDecl}\n${withNs}`;
}

/**
 * Write a {@link Profile} object to a file as Salesforce-compatible XML.
 *
 * @param filePath - Absolute path to write the `.profile-meta.xml` file
 * @param profile - The Profile object to serialize
 */
export async function writeProfileXml(
  filePath: string,
  profile: Profile,
): Promise<void> {
  const xml = buildProfileXml(profile);
  await writeFile(filePath, xml, 'utf8');
}

// ============================================================================
// Normalization helpers
// ============================================================================

/**
 * Normalize a raw parsed object into a well-typed {@link Profile}.
 *
 * - Converts `"true"` / `"false"` strings to booleans
 * - Ensures array properties are always arrays
 * - Keeps scalar properties as scalars
 */
function normalizeProfile(raw: Record<string, unknown>): Profile {
  const result: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(raw)) {
    if (SCALAR_PROPERTIES.has(key)) {
      result[key] = normalizePrimitive(value);
    } else if (ARRAY_PROPERTIES.has(key)) {
      const arr = Array.isArray(value) ? value : [value];
      result[key] = arr.map(item =>
        typeof item === 'object' && item !== null
          ? normalizeObject(item as Record<string, unknown>)
          : normalizePrimitive(item));
    } else if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
      // Nested scalar object (e.g., loginHours)
      result[key] = normalizeObject(value as Record<string, unknown>);
    } else {
      result[key] = normalizePrimitive(value);
    }
  }

  return result as Profile;
}

function normalizeObject(obj: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    result[key] = normalizePrimitive(value);
  }

  return result;
}

function normalizePrimitive(value: unknown): unknown {
  if (value === 'true') return true;
  if (value === 'false') return false;
  return value;
}
