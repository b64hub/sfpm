import type {WorkspacePackageJson} from '../project/providers/types/workspace.js';

import SfpmPackage, {SfpmDataPackage, SfpmMetadataPackage, SfpmUnlockedPackage} from '../package/sfpm-package.js';
/**
 * Adapter for converting between npm package.json and SFPM domain models.
 *
 * Responsibilities:
 * - Write: WorkspacePackageJson + SfpmPackage → NpmPackageJson
 *   Reads flat properties from the domain model to build the artifact JSON.
 *   Single source of truth for the JSON shape.
 *
 * - Read:  NpmPackageJson → SfpmPackageMetadataBase
 *   Extracts SFPM metadata from a published artifact's package.json for
 *   artifact resolution and installation.
 */
import {ARTIFACT_SOURCE_DIR} from '../types/artifact.js';
import {NpmPackageJson, SfpmArtifactMetadata} from '../types/npm.js';
import {
  PackageType,
  SfpmPackageMetadataBase,
  SfpmUnlockedPackageMetadata,
} from '../types/package.js';
import {extractScope, stripScope} from '../utils/scope-utils.js';
import {toVersionFormat} from '../utils/version-utils.js';

// ---------------------------------------------------------------------------
// Write path: WorkspacePackageJson + SfpmPackage → NpmPackageJson
// ---------------------------------------------------------------------------

/**
 * Build-time options for generating an artifact package.json.
 */
export interface ToNpmPackageJsonOptions {
  /** Additional keywords to append (e.g., build-injected tags) */
  additionalKeywords?: string[];
  /** Pre-classified managed dependencies (alias → packageVersionId 04t...) */
  managedDependencies?: Record<string, string>;
  /** Repository URL to set as top-level npm field */
  repositoryUrl?: string;
  /** Source hash of the package content */
  sourceHash?: string;
}

/**
 * Build an artifact package.json by overlaying build-time properties onto
 * the workspace package.json.
 *
 * Reads flat properties directly from the SfpmPackage domain model —
 * no toJson() indirection.
 */
export function toNpmPackageJson(
  workspacePkgJson: WorkspacePackageJson,
  pkg: SfpmPackage,
  version: string,
  options: ToNpmPackageJsonOptions = {},
): NpmPackageJson {
  // Top-level version is base semver (no build suffix).
  const baseVersion = toVersionFormat(version, 'semver', {includeBuildNumber: false});

  // Build sfpm metadata from flat package properties.
  const buildMetadata = removeEmptyValues(buildMetadataFromPackage(pkg, baseVersion));
  const sfpmMeta = {
    ...workspacePkgJson.sfpm,
    ...buildMetadata,
  } as SfpmArtifactMetadata;

  // Inject sourceHash directly on the sfpm object (no nested source)
  if (options.sourceHash) {
    sfpmMeta.sourceHash = options.sourceHash;
  }

  // Clean up legacy nested source if it leaked from workspace config
  delete (sfpmMeta as any).source;

  // sourceBehaviorOptions is a project-level setting, not a per-package concern.
  delete (sfpmMeta as any).sourceBehaviorOptions;

  // Build keywords
  const baseKeywords = workspacePkgJson.keywords ?? [];
  const sfpmKeywords = ['sfpm', 'salesforce', String(pkg.type)];
  const additionalKeywords = options.additionalKeywords ?? [];
  const keywords = [...new Set([...additionalKeywords, ...baseKeywords, ...sfpmKeywords])];

  // Artifact always stages source under ARTIFACT_SOURCE_DIR regardless of original path
  const packageSourcePath = ARTIFACT_SOURCE_DIR;

  // Start from workspace package.json, omit workspace-only fields.
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

  // Override managedDependencies from build options if provided
  if (options.managedDependencies && Object.keys(options.managedDependencies).length > 0) {
    packageJson.managedDependencies = options.managedDependencies;
  }

  // Add repository if available (npm convention — top-level field)
  const repository = buildRepositoryField(options.repositoryUrl);
  if (repository) {
    packageJson.repository = repository;
  }

  return packageJson;
}

// ---------------------------------------------------------------------------
// Build metadata from flat package properties
// ---------------------------------------------------------------------------

/**
 * Construct the sfpm metadata object by reading flat properties from the
 * domain model. This is the single source of truth for the artifact JSON shape.
 *
 * Omits fields derivable from top-level npm fields:
 * - `packageName` / `scope` — derivable from top-level `name`
 * - `versionNumber` — only emitted when it includes a build segment
 *   that differs from the top-level `version`
 */
function buildMetadataFromPackage(pkg: SfpmPackage, baseVersion: string): Record<string, any> {
  const base: Record<string, any> = {
    packageType: pkg.type,
  };

  // Only emit versionNumber when it carries a build segment the top-level version doesn't
  const fullVersion = pkg.version;
  if (fullVersion && fullVersion !== baseVersion) {
    base.versionNumber = fullVersion;
  }

  if (pkg.apiVersion) base.apiVersion = pkg.apiVersion;

  // Metadata packages: add content + validation
  if (pkg instanceof SfpmMetadataPackage) {
    base.content = simplifyContent(pkg.resolveContentMetadata());
    base.packageType = pkg.type || pkg.packageDefinition?.type;

    if (pkg.validationState) {
      base.validation = pkg.validationState;
    }
  }

  // Unlocked packages: add identity fields
  if (pkg instanceof SfpmUnlockedPackage) {
    base.isOrgDependent = pkg.isOrgDependent;
    if (pkg.packageId) base.packageId = pkg.packageId;
    if (pkg.packageVersionId) base.packageVersionId = pkg.packageVersionId;
  }

  // Data packages: add data-specific content
  if (pkg instanceof SfpmDataPackage) {
    base.content = {
      dataDirectory: pkg.packageDefinition?.path || '',
    };
  }

  return base;
}

/**
 * Simplify content for artifact serialization.
 * Apex classes/tests → names only (no paths).
 */
function simplifyContent(content: Record<string, any>): Record<string, any> {
  const simplified = {...content};

  if (simplified.apex) {
    simplified.apex = {...simplified.apex};
    if (Array.isArray(simplified.apex.classes)) {
      simplified.apex.classes = simplified.apex.classes.map((c: any) => (typeof c === 'string' ? c : c.name));
    }

    if (Array.isArray(simplified.apex.tests)) {
      simplified.apex.tests = simplified.apex.tests.map((t: any) => (typeof t === 'string' ? t : t.name));
    }
  }

  return simplified;
}

// ---------------------------------------------------------------------------
// Read path: NpmPackageJson → hydrate domain model
// ---------------------------------------------------------------------------

/**
 * Hydrate an SfpmPackage instance from an artifact's package.json.
 *
 * Sets flat properties directly on the domain model:
 * version, source, apiVersion, and (for metadata packages) content,
 * testCoverage, validationState. For unlocked packages, sets packageId,
 * packageVersionId, isOrgDependent.
 *
 * This is the read-side counterpart to `buildMetadataFromPackage()`.
 */
export function hydrateFromNpmPackageJson(pkg: SfpmPackage, packageJson: NpmPackageJson): void {
  const {sfpm} = packageJson;
  if (!sfpm) return;

  // Version: prefer sfpm.versionNumber (has build segment), fall back to top-level
  const version = sfpm.versionNumber || packageJson.version;
  if (version) pkg.version = version;

  if (sfpm.apiVersion) pkg.apiVersion = sfpm.apiVersion;

  // Source hash
  const {sourceHash} = sfpm;
  if (sourceHash) {
    pkg.sourceHash = sourceHash;
  }

  // Metadata packages: content + validation
  if (pkg instanceof SfpmMetadataPackage) {
    if (sfpm.content) {
      pkg.updateContent(sfpm.content);
    }

    if (sfpm.content?.testCoverage !== undefined) {
      pkg.testCoverage = sfpm.content.testCoverage;
    }

    if (sfpm.validation) {
      pkg.validationState = sfpm.validation;
    }
  }

  // Unlocked packages: identity fields
  if (pkg instanceof SfpmUnlockedPackage) {
    if (sfpm.packageId) pkg.packageId = sfpm.packageId;
    if (sfpm.packageVersionId) pkg.packageVersionId = sfpm.packageVersionId;
    if (sfpm.isOrgDependent !== undefined) pkg.isOrgDependent = sfpm.isOrgDependent;
  }
}

/**
 * Convert an npm package.json (with sfpm metadata) to a raw SfpmPackageMetadataBase.
 *
 * Prefer `hydrateFromNpmPackageJson()` when you have a package instance.
 * This function exists for cases where only the raw metadata bag is needed
 * (e.g., artifact repository metadata storage).
 */
export function fromNpmPackageJson(packageJson: NpmPackageJson): SfpmPackageMetadataBase {
  const {sfpm} = packageJson;

  // Derive packageName and scope from top-level name (canonical source)
  const topLevelName = packageJson.name || '';
  const packageName = sfpm.packageName ?? stripScope(topLevelName);
  const scope = sfpm.scope ?? extractScope(topLevelName);

  const metadata: SfpmPackageMetadataBase = {
    ...sfpm,
    packageName,
    scope: scope || '',
    versionNumber: sfpm.versionNumber || packageJson.version,
  };

  // Reconstruct source for the metadata bag (external consumers)
  const {sourceHash} = sfpm;
  const repositoryUrl = getRepositoryUrl(packageJson.repository);
  if (sourceHash || repositoryUrl) {
    metadata.source = {repositoryUrl, sourceHash};
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

export function extractPackageVersionId(packageJson: NpmPackageJson): string | undefined {
  const sfpm = packageJson.sfpm as SfpmUnlockedPackageMetadata | undefined;
  return sfpm?.packageVersionId;
}

export function extractSourceHash(packageJson: NpmPackageJson): string | undefined {
  return packageJson.sfpm?.sourceHash;
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

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

function buildRepositoryField(url?: string): string | undefined {
  if (!url) return undefined;
  return url;
}

/** Extract URL from the repository field (handles string and object forms). */
function getRepositoryUrl(repository?: string | {type: string; url: string}): string | undefined {
  if (!repository) return undefined;
  return typeof repository === 'string' ? repository : repository.url;
}
