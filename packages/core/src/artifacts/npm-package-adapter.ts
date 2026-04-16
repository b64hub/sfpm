import type {WorkspacePackageJson} from '../types/workspace.js';

import SfpmPackage from '../package/sfpm-package.js';
/**
 * Adapter for converting between npm package.json and SFPM domain models.
 *
 * Responsibilities:
 * - Write: WorkspacePackageJson + SfpmPackage → NpmPackageJson
 *   Takes the workspace package.json as the base (static config: name, version,
 *   author, license, dependencies, etc.) and overlays build-time properties
 *   (sfpm metadata, files list, repository URL, resolved version).
 *
 * - Read:  NpmPackageJson → SfpmPackageMetadataBase
 *   Extracts SFPM metadata from a published artifact's package.json for
 *   artifact resolution and installation.
 *
 * Design decisions:
 * - Static npm fields come from the workspace package.json — not from build options
 * - Build-time additions: `sfpm` enriched with metadata, `files`, `repository`
 * - No duplication: `repository.url` at top level, `source.repositoryUrl` excluded from sfpm
 */
import {NpmPackageJson, SfpmArtifactMetadata} from '../types/npm.js';
import {
  SfpmPackageMetadataBase,
  SfpmUnlockedPackageMetadata,
} from '../types/package.js';
import {toVersionFormat} from '../utils/version-utils.js';

// ---------------------------------------------------------------------------
// Write path: WorkspacePackageJson + SfpmPackage → NpmPackageJson
// ---------------------------------------------------------------------------

/**
 * Build-time options for generating an artifact package.json.
 *
 * Only includes concerns that are determined at build time.
 * Static configuration (author, license, keywords, etc.) comes from the
 * workspace package.json passed as the first argument.
 */
export interface ToNpmPackageJsonOptions {
  /** Additional keywords to append (e.g., build-injected tags) */
  additionalKeywords?: string[];
  /** Pre-classified managed dependencies (alias → packageVersionId 04t...) */
  managedDependencies?: Record<string, string>;
}

/**
 * Build an artifact package.json by overlaying build-time properties onto
 * the workspace package.json.
 *
 * Static fields (name, version, author, license, description, keywords,
 * dependencies, managedDependencies) are inherited from the workspace
 * package.json. The adapter only adds or overrides build-time concerns:
 * - `version` — resolved base semver (no build suffix)
 * - `sfpm` — workspace config merged with build metadata
 * - `files` — list of files to include in the tarball
 * - `repository` — reconstructed from source metadata
 * - `keywords` — appended with build-injected tags
 *
 * @param workspacePkgJson - The workspace package.json (source of truth for static config)
 * @param pkg - The SfpmPackage with build-time metadata
 * @param version - The resolved version string (e.g., "1.0.0-1")
 * @param options - Build-time options
 */
export async function toNpmPackageJson(
  workspacePkgJson: WorkspacePackageJson,
  pkg: SfpmPackage,
  version: string,
  options: ToNpmPackageJsonOptions = {},
): Promise<NpmPackageJson> {
  // Top-level version is base semver (no build suffix).
  // The full version with build number lives in sfpm.versionNumber.
  const baseVersion = toVersionFormat(version, 'semver', {includeBuildNumber: false});

  // Build sfpm metadata: merge workspace static config with build-time metadata.
  // Cast to SfpmArtifactMetadata — at this boundary we trust the metadata
  // produced by toJson() to be the canonical artifact representation.
  const buildMetadata = removeEmptyValues(await pkg.toJson());
  const sfpmMeta = {
    ...workspacePkgJson.sfpm,
    ...buildMetadata,
  } as SfpmArtifactMetadata;

  // Remove repositoryUrl from sfpm.source — it lives at the npm top-level `repository`
  if (sfpmMeta?.source?.repositoryUrl) {
    const {repositoryUrl: _, ...rest} = sfpmMeta.source;
    sfpmMeta.source = rest;
  }

  // Build keywords: workspace keywords + sfpm defaults + additional build-time keywords
  const baseKeywords = workspacePkgJson.keywords ?? [];
  const sfpmKeywords = ['sfpm', 'salesforce', String(pkg.type)];
  const additionalKeywords = options.additionalKeywords ?? [];
  const keywords = [...new Set([...additionalKeywords, ...baseKeywords, ...sfpmKeywords])];

  const packageSourcePath = pkg.packageDefinition?.path || 'force-app';

  // Start from the workspace package.json, then overlay build-time properties.
  // Destructure to omit workspace-only fields that shouldn't be in the artifact.
  const {devDependencies: _devDeps, private: _private, scripts: _scripts, ...staticFields} = workspacePkgJson;

  const packageJson: NpmPackageJson = {
    ...staticFields,
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
    sfpm: sfpmMeta,
    version: baseVersion,
  };

  // Override managedDependencies from build options if provided (classified at build time)
  if (options.managedDependencies && Object.keys(options.managedDependencies).length > 0) {
    packageJson.managedDependencies = options.managedDependencies;
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
