import semver from 'semver';

import type {PackageType, VersionFormat} from '../types/package.js';

/**
 * Pure version formatting and conversion utilities.
 *
 * The primary entry point is {@link toVersionFormat}, which accepts a
 * {@link VersionFormat} (`'semver'` | `'salesforce'`) to convert between
 * Salesforce's 4-part format (`major.minor.patch.build`) and npm/semver
 * format (`major.minor.patch-build`).
 *
 * Additional helpers handle build-token extraction and Salesforce-specific
 * version conventions (`.NEXT` for unlocked, `.0` for source/data).
 */

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

/**
 * Options for {@link toVersionFormat}.
 */
export interface VersionFormatOptions {
  /**
   * Include the build segment in the output.
   * When `false`, returns only `major.minor.patch`.
   * @default true
   */
  includeBuildNumber?: boolean;
  /**
   * Replace non-numeric tokens (`NEXT`, `LATEST`) with `'0'`.
   * Useful when the result will be compared with semver utilities
   * that require numeric prerelease identifiers.
   * @default false
   */
  resolveTokens?: boolean;
  /**
   * Throw on invalid input (`true`) or return the input as-is (`false`).
   * @default true
   */
  strict?: boolean;
}

// ---------------------------------------------------------------------------
// Primary API
// ---------------------------------------------------------------------------

/**
 * Convert a version string to the requested format.
 *
 * This is the single entry point for all version string conversions between
 * Salesforce's 4-part format (`major.minor.patch.build`) and npm/semver
 * format (`major.minor.patch-build`).
 *
 * @param version - Version string in any supported format
 * @param format  - Target format: `'semver'` (default) or `'salesforce'`
 * @param options - Formatting options
 * @returns Formatted version string
 *
 * @example
 * // Normalize to semver
 * toVersionFormat('1.0.0.7', 'semver')          // '1.0.0-7'
 *
 * // Convert to Salesforce
 * toVersionFormat('1.0.0-7', 'salesforce')       // '1.0.0.7'
 *
 * // Lenient semver for comparison (NEXT → 0, no throw)
 * toVersionFormat('1.0.0.NEXT', 'semver', { strict: false, resolveTokens: true })
 *                                                // '1.0.0-0'
 *
 * // Strip build number
 * toVersionFormat('1.0.0-7', 'semver', { includeBuildNumber: false })
 *                                                // '1.0.0'
 */
export function toVersionFormat(
  version: string,
  format: VersionFormat = 'semver',
  options?: VersionFormatOptions,
): string {
  const strict = options?.strict ?? true;
  const includeBuild = options?.includeBuildNumber ?? true;
  const resolveTokens = options?.resolveTokens ?? false;

  if (!version) {
    return format === 'salesforce' ? '0.0.0.NEXT' : '0.0.0';
  }

  // Step 1: Parse to a canonical semver representation
  let normalized: string;
  try {
    normalized = parseToSemver(version, resolveTokens);
  } catch {
    if (!strict) return version;
    throw new Error(`Invalid version format: "${version}". `
      + 'Expected major.minor.patch.build or valid semver.');
  }

  // Step 2: Strip build segment if requested
  if (!includeBuild) {
    return normalized.replace(/[-.]([\dA-Za-z]+)$/, '');
  }

  // Step 3: Convert to target format
  if (format === 'salesforce') {
    return semverToSalesforce(normalized);
  }

  return normalized;
}

/**
 * Formats numeric version components into a version string.
 *
 * @param major  - Major version number
 * @param minor  - Minor version number
 * @param patch  - Patch version number
 * @param build  - Build number
 * @param format - Target format. Default: `'salesforce'` (dot-separated)
 * @returns Formatted version string
 *
 * @example
 * formatVersion(1, 2, 3, 4)                // '1.2.3.4'
 * formatVersion(1, 2, 3, 4, 'semver')      // '1.2.3-4'
 */
export function formatVersion(
  major: number,
  minor: number,
  patch: number,
  build: number,
  format: VersionFormat = 'salesforce',
): string {
  return format === 'semver'
    ? `${major}.${minor}.${patch}-${build}`
    : `${major}.${minor}.${patch}.${build}`;
}

// ---------------------------------------------------------------------------
// Build token / suffix utilities
// ---------------------------------------------------------------------------

/** Known Salesforce build tokens used as version suffixes. */
const KNOWN_TOKENS = ['NEXT', 'LATEST'] as const;
type BuildToken = typeof KNOWN_TOKENS[number];

/**
 * Extract the build-segment suffix from a version string.
 *
 * Returns the suffix including its separator (`.NEXT`, `-7`, `.0`), or an
 * empty string when the version has no build segment.
 *
 * @example
 * getVersionSuffix('1.0.0.NEXT')   // '.NEXT'
 * getVersionSuffix('1.0.0-7')      // '-7'
 * getVersionSuffix('1.0.0-NEXT')   // '-NEXT'
 * getVersionSuffix('1.0.0.0')      // '.0'
 * getVersionSuffix('1.0.0')        // ''
 */
export function getVersionSuffix(version: string): string {
  if (!version) return '';

  // Check for dot-separated 4-part (Salesforce format): 1.0.0.NEXT, 1.0.0.0
  const sfMatch = version.match(/^(\d+\.\d+\.\d+)(\.\w+)$/);
  if (sfMatch) return sfMatch[2];

  // Check for semver prerelease: 1.0.0-NEXT, 1.0.0-7
  const semverMatch = version.match(/^(\d+\.\d+\.\d+)(-\w+)$/);
  if (semverMatch) return semverMatch[2];

  return '';
}

/**
 * Strip the build segment from a version string, returning only `major.minor.patch`.
 *
 * Handles both Salesforce (`.`) and semver (`-`) separators, and recognises
 * token suffixes like `.NEXT` and `.LATEST`.
 *
 * @example
 * stripBuildSegment('1.0.0.NEXT')   // '1.0.0'
 * stripBuildSegment('1.0.0-7')      // '1.0.0'
 * stripBuildSegment('1.0.0')        // '1.0.0'
 */
export function stripBuildSegment(version: string): string {
  if (!version) return '0.0.0';

  // Remove known token suffixes (both . and - separators)
  for (const token of KNOWN_TOKENS) {
    const dotSuffix = `.${token}`;
    const dashSuffix = `-${token}`;
    if (version.endsWith(dotSuffix)) return version.slice(0, -dotSuffix.length);
    if (version.endsWith(dashSuffix)) return version.slice(0, -dashSuffix.length);
  }

  // Salesforce 4-part: 1.0.0.7 → 1.0.0
  const parts = version.split('.');
  if (parts.length === 4) return parts.slice(0, 3).join('.');

  // Semver prerelease: 1.0.0-7 → 1.0.0
  const dashIdx = version.lastIndexOf('-');
  if (dashIdx > 0) return version.slice(0, dashIdx);

  return version;
}

/**
 * Convert a semver version to Salesforce format, appending the appropriate
 * build token based on package type.
 *
 * - **Unlocked** packages use `.NEXT` as a placeholder for the Salesforce-assigned build number.
 * - **Source/Data/Diff** packages use `.0` since they don't go through Salesforce packaging.
 * - Versions that already have a build segment (e.g., `1.0.0-5`) are converted directly.
 *
 * @example
 * toSalesforceVersionWithToken('1.0.0', 'unlocked')  // '1.0.0.NEXT'
 * toSalesforceVersionWithToken('1.0.0', 'source')     // '1.0.0.0'
 * toSalesforceVersionWithToken('1.0.0-5', 'unlocked') // '1.0.0.5'
 */
export function toSalesforceVersionWithToken(
  version: string,
  packageType: Exclude<PackageType, 'managed'>,
): string {
  // If version already has a prerelease/build segment, convert directly
  if (version.includes('-')) {
    return toVersionFormat(version, 'salesforce');
  }

  // Salesforce 4-part already — return as-is
  if (/^\d+\.\d+\.\d+\.\w+$/.test(version)) {
    return version;
  }

  // Plain semver (no build) — append the appropriate build token
  const token = packageType === 'unlocked' ? 'NEXT' : '0';
  return `${version}.${token}`;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Parse any supported version format into canonical semver.
 *
 * @param version       - Input version string
 * @param resolveTokens - Replace NEXT/LATEST with 0
 * @returns Canonical semver string
 * @throws On unparseable input
 */
function parseToSemver(version: string, resolveTokens: boolean): string {
  const input = resolveTokens
    ? version.replaceAll(/\b(NEXT|LATEST)\b/gi, '0')
    : version;

  // 1. Already valid semver?
  const valid = semver.valid(input);
  if (valid) return valid;

  // 2. Salesforce 4-part format: major.minor.patch.build
  const segments = input.split('.');
  if (segments.length === 4) {
    const transformed = `${segments[0]}.${segments[1]}.${segments[2]}-${segments[3]}`;
    const v = semver.valid(transformed);
    if (v) return v;
  }

  // 3. Coerce loose formats (v1.0, 1, etc.)
  const coerced = semver.coerce(input);
  if (coerced) return coerced.version;

  throw new Error(`Cannot parse version: ${version}`);
}

/**
 * Convert a semver string to Salesforce 4-part format.
 *
 * @param version - Valid semver string (e.g. '1.0.0-7', '1.0.0-NEXT')
 * @returns Salesforce format (e.g. '1.0.0.7', '1.0.0.NEXT')
 */
function semverToSalesforce(version: string): string {
  // Already in Salesforce format?
  if (/^\d+\.\d+\.\d+\.(\d+|NEXT|LATEST)$/i.test(version)) {
    return version;
  }

  // semver with prerelease: major.minor.patch-build → major.minor.patch.build
  const match = version.match(/^(\d+\.\d+\.\d+)-(.+)$/);
  if (match) {
    return `${match[1]}.${match[2]}`;
  }

  // Plain 3-part → append .NEXT
  if (/^\d+\.\d+\.\d+$/.test(version)) {
    return `${version}.NEXT`;
  }

  throw new Error(`Cannot convert "${version}" to Salesforce format. `
    + 'Expected major.minor.patch-build or major.minor.patch.build.');
}
