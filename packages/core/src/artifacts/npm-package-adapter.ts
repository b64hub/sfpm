import SfpmPackage from '../package/sfpm-package.js';
/**
 * Adapter for converting between npm package.json and SFPM domain models.
 *
 * Responsibilities:
 * - Write: SfpmPackage → NpmPackageJson (for artifact assembly / npm publish)
 * - Read:  NpmPackageJson → SfpmPackageMetadataBase (for artifact resolution / install)
 *
 * Design decisions:
 * - Standard npm fields (name, version, repository, description) live at the top level
 * - All SFPM-specific metadata lives under the `sfpm` property as a nested structure
 *   matching `SfpmPackageMetadataBase` (identity, source, orchestration, content)
 * - No duplication: `repository.url` at top level, `source.repositoryUrl` excluded from sfpm
 * - `source.commit` (renamed from `commitSHA` internally) in sfpm for brevity
 */
import {NpmPackageJson, SfpmArtifactMetadata} from '../types/npm.js';
import {
  SfpmPackageMetadataBase,
  SfpmUnlockedPackageMetadata,
} from '../types/package.js';
import {toVersionFormat} from '../utils/version-utils.js';

// ---------------------------------------------------------------------------
// Write path: SfpmPackage → NpmPackageJson
// ---------------------------------------------------------------------------

/**
 * Options for generating a package.json from an SfpmPackage.
 * Only includes fields relevant to the package.json content — assembly concerns
 * (changelog provider, quietPack, etc.) stay in ArtifactAssemblerOptions.
 */
export interface ToNpmPackageJsonOptions {
  /** Additional keywords for package.json */
  additionalKeywords?: string[];
  /** Author string for package.json */
  author?: string;
  /** License identifier for package.json */
  license?: string;
  /** Pre-classified managed dependencies (alias → packageVersionId 04t...) */
  managedDependencies?: Record<string, string>;
}

/**
 * Build a complete npm package.json from an SfpmPackage and its metadata.
 *
 * Convention:
 * - Standard npm fields (name, version, repository, description) at top level
 * - SFPM-specific metadata under `sfpm` as nested `SfpmPackageMetadataBase`
 * - `repositoryUrl` promoted to top-level `repository`, removed from `sfpm.source`
 */
export async function toNpmPackageJson(
  pkg: SfpmPackage,
  version: string,
  options: ToNpmPackageJsonOptions,
): Promise<NpmPackageJson> {
  const {additionalKeywords, author, license} = options;

  // Resolve the npm package name — workspace mode provides it from package.json,
  // legacy mode would need migration via `sfpm init turbo`.
  const {npmName} = pkg;
  if (!npmName) {
    throw new Error(`Package "${pkg.packageName}" has no npm name. `
      + 'In workspace mode, this is set from the package.json "name" field. '
      + 'Run `sfpm init turbo` to migrate from sfdx-project.json.');
  }

  // Top-level version is base semver (no build suffix).
  // The full version with build number lives in sfpm.versionNumber.
  const baseVersion = toVersionFormat(version, 'semver', {includeBuildNumber: false});

  // Get sfpm metadata from the package and strip empty properties.
  // Cast to SfpmArtifactMetadata — at this boundary we trust the metadata
  // produced by toJson() to be the canonical artifact representation.
  // Config-only fields (packageOptions, hooks, etc.) will be added as the
  // adapter evolves to merge workspace config into the artifact.
  const sfpmMeta = removeEmptyValues(await pkg.toJson()) as SfpmArtifactMetadata;

  // Remove repositoryUrl from sfpm.source — it lives at the npm top-level `repository`
  if (sfpmMeta?.source?.repositoryUrl) {
    const {repositoryUrl: _, ...rest} = sfpmMeta.source;
    sfpmMeta.source = rest;
  }

  // Managed dependencies live at the top level (consistent with workspace package.json)
  const managedDependencies = options.managedDependencies ?? {};

  const keywords = ['sfpm', 'salesforce', String(pkg.type), ...(additionalKeywords || [])];
  const packageSourcePath = pkg.packageDefinition?.path || 'force-app';

  const packageJson: NpmPackageJson = {
    description: pkg.packageDefinition?.versionDescription || `SFPM ${pkg.type} package: ${pkg.packageName}`,
    files: [
      `${packageSourcePath}/**`,
      'scripts/**',
      'manifest/**',
      'config/**',
      'sfdx-project.json',
      '.forceignore',
      'changelog.json',
    ],
    keywords,
    license: license || 'UNLICENSED',
    name: npmName,
    sfpm: sfpmMeta,
    version: baseVersion,
  };

  if (author) {
    packageJson.author = author;
  }

  if (Object.keys(managedDependencies).length > 0) {
    packageJson.managedDependencies = managedDependencies;
  }

  // Add repository if available (npm convention — top-level field)
  if (pkg.metadata?.source?.repositoryUrl) {
    packageJson.repository = {
      type: 'git',
      url: pkg.metadata.source.repositoryUrl,
    };
  }

  return packageJson;
}

// ---------------------------------------------------------------------------
// Read path: NpmPackageJson → SfpmPackageMetadataBase
// ---------------------------------------------------------------------------

/**
 * Convert an npm package.json (with sfpm metadata) back to an SfpmPackageMetadataBase.
 *
 * The `sfpm` property stores a flat SfpmPackageMetadataBase directly
 * (packageName, packageType, versionNumber, source, orchestration, etc.).
 *
 * Also reconstructs `source.repositoryUrl` from the top-level `repository` field
 * when present, so domain code can access it uniformly.
 */
export function fromNpmPackageJson(packageJson: NpmPackageJson): SfpmPackageMetadataBase {
  const {sfpm} = packageJson;

  const metadata: SfpmPackageMetadataBase = {
    ...sfpm,
    source: {
      ...sfpm.source,
    },
    // sfpm.versionNumber contains the full version with build suffix
    versionNumber: sfpm.versionNumber || packageJson.version,
  };

  // Reconstruct repositoryUrl from npm top-level field if not already set
  if (!metadata.source.repositoryUrl && packageJson.repository?.url) {
    metadata.source.repositoryUrl = packageJson.repository.url;
  }

  // Backward compat: older artifacts may have managedDependencies under sfpm
  if (!metadata.managedDependencies && (packageJson as any).managedDependencies) {
    metadata.managedDependencies = (packageJson as any).managedDependencies;
  }

  return metadata;
}

// ---------------------------------------------------------------------------
// Extraction helpers
// ---------------------------------------------------------------------------

/**
 * Extract the packageVersionId (04t...) from an npm package.json.
 * Returns undefined if the package is not an unlocked package or has no version ID.
 */
export function extractPackageVersionId(packageJson: NpmPackageJson): string | undefined {
  const sfpm = packageJson.sfpm as SfpmUnlockedPackageMetadata | undefined;
  return sfpm?.packageVersionId;
}

/**
 * Extract the sourceHash from an npm package.json's sfpm metadata.
 */
export function extractSourceHash(packageJson: NpmPackageJson): string | undefined {
  return packageJson.sfpm?.source?.sourceHash;
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

/**
 * Recursively removes empty values from an object to keep serialized JSON clean.
 * Removes: empty arrays [], empty objects {}, null, and undefined.
 * Preserves: non-empty values, booleans, numbers (including 0), and non-empty strings.
 */
function removeEmptyValues<T>(obj: T): T {
  if (obj === null || obj === undefined) {
    return obj;
  }

  if (Array.isArray(obj)) {
    return obj.length === 0 ? undefined as unknown as T : obj;
  }

  if (typeof obj === 'object') {
    const cleaned: Record<string, any> = {};

    for (const [key, value] of Object.entries(obj as Record<string, any>)) {
      const cleanedValue = removeEmptyValues(value);

      if (cleanedValue === undefined || cleanedValue === null) {
        continue;
      }

      if (Array.isArray(cleanedValue) && cleanedValue.length === 0) {
        continue;
      }

      if (typeof cleanedValue === 'object' && !Array.isArray(cleanedValue) && Object.keys(cleanedValue).length === 0) {
        continue;
      }

      cleaned[key] = cleanedValue;
    }

    return (Object.keys(cleaned).length === 0 ? {} : cleaned) as T;
  }

  return obj;
}
