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
import {ARTIFACT_SOURCE_DIR, SfpmPackageSource} from '../types/artifact.js';
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
  /** Source context (git commit, branch, repo, sourceHash) to embed in the artifact */
  source?: SfpmPackageSource;
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

  // Inject source context from build options (not from the domain model)
  if (options.source) {
    sfpmMeta.source = {...options.source};
  }

  // Remove repositoryUrl from sfpm.source — it lives at the npm top-level `repository`
  stripRepositoryUrl(sfpmMeta);

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
  const repository = buildRepositoryField(options.source?.repositoryUrl);
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
  if (pkg.source) base.source = pkg.source;

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
// Read path: NpmPackageJson → SfpmPackageMetadataBase
// ---------------------------------------------------------------------------

/**
 * Convert an npm package.json (with sfpm metadata) back to an SfpmPackageMetadataBase.
 *
 * Derives `packageName` and `scope` from the top-level `name` field
 * (they are no longer duplicated in the `sfpm` section).
 */
export function fromNpmPackageJson(packageJson: NpmPackageJson): SfpmPackageMetadataBase {
  const {sfpm} = packageJson;

  // Derive packageName and scope from top-level name (canonical source)
  const topLevelName = packageJson.name || '';
  const packageName = sfpm.packageName ?? stripScope(topLevelName);
  const scope = sfpm.scope ?? extractScope(topLevelName);

  const metadata: SfpmPackageMetadataBase = {
    ...sfpm,
    ...(sfpm.source ? {source: {...sfpm.source}} : {}),
    packageName,
    scope: scope || '',
    versionNumber: sfpm.versionNumber || packageJson.version,
  };

  // Reconstruct repositoryUrl from npm top-level field if not already set
  if (metadata.source) {
    restoreRepositoryUrl(metadata.source, packageJson.repository?.url);
  } else if (packageJson.repository?.url) {
    metadata.source = {repositoryUrl: packageJson.repository.url};
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
  return packageJson.sfpm?.source?.sourceHash;
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

function stripRepositoryUrl(sfpmMeta: SfpmArtifactMetadata): void {
  if (sfpmMeta?.source?.repositoryUrl) {
    const {repositoryUrl: _, ...rest} = sfpmMeta.source;
    sfpmMeta.source = rest;
  }
}

function buildRepositoryField(url?: string): undefined | {type: string; url: string} {
  if (!url) return undefined;
  return {type: 'git', url};
}

function restoreRepositoryUrl(source: SfpmPackageSource, repositoryUrl?: string): void {
  if (!source.repositoryUrl && repositoryUrl) {
    source.repositoryUrl = repositoryUrl;
  }
}
