/**
 * Types for npm package.json generation from SFPM packages.
 *
 * The artifact's package.json shares the same base structure as the workspace
 * package.json (see `SfpmPackageJson` in workspace.ts). The key difference is
 * the `sfpm` property: in the repo it contains only static configuration
 * (`SfpmPackageConfig`); in a built artifact it is enriched with build-time
 * metadata via `SfpmArtifactMetadata` (= `SfpmPackageConfig & SfpmPackageMetadataBase`).
 */

import {PackageType, SfpmPackageMetadataBase} from './package.js';
import {SfpmPackageConfig, SfpmPackageJson} from './workspace.js';

// ---------------------------------------------------------------------------
// Artifact sfpm property
// ---------------------------------------------------------------------------

/**
 * The merged `sfpm` property type for built artifacts.
 *
 * Combines static package configuration (`SfpmPackageConfig` — package type,
 * deploy options, hooks, etc.) with build-time metadata (`SfpmPackageMetadataBase`
 * — source info, orchestration, content analysis, version).
 *
 * TypeScript intersection (`&`) merges both interfaces so the artifact's
 * `sfpm` field carries everything the workspace config had, plus all the
 * metadata the build pipeline produces.
 */
export type SfpmArtifactMetadata = SfpmPackageConfig & SfpmPackageMetadataBase;

// ---------------------------------------------------------------------------
// Artifact package.json
// ---------------------------------------------------------------------------

/**
 * Artifact package.json generated during build and published to an npm registry.
 *
 * Extends the shared `SfpmPackageJson` base with:
 * - `sfpm` enriched with build metadata (`SfpmArtifactMetadata`)
 * - npm publish fields (`files`, `repository`)
 *
 * @see https://docs.npmjs.com/cli/v10/configuring-npm/package-json
 */
export interface NpmPackageJson extends SfpmPackageJson<SfpmArtifactMetadata> {
  /**
   * Files to include in the package tarball.
   * SFPM includes source, scripts, manifests, and sfdx-project.json.
   */
  files?: string[];

  /** Repository URL */
  repository?: {
    type: string;
    url: string;
  };
}

/**
 * Options for generating package.json
 */
export interface PackageJsonGeneratorOptions {
  /** Additional keywords to include */
  additionalKeywords?: string[];
  /** Source hash to include in metadata */
  sourceHash?: string;
}

/**
 * Converts an SFPM dependency to npm optionalDependency format.
 *
 * sfdx-project.json format:
 *   { "package": "my-dependency", "versionNumber": "1.2.0.LATEST" }
 *
 * npm format:
 *   { "@scope/my-dependency": "^1.2.0" }
 *
 * @param dep - Dependency from sfdx-project.json
 * @param npmScope - npm scope to use
 * @returns Tuple of [packageName, versionRange]
 */
export function convertDependencyToNpm(
  dep: {package: string; versionNumber?: string},
  npmScope: string,
): [string, string] {
  const npmPackageName = `${npmScope}/${dep.package}`;

  // Extract base version (major.minor.patch) from sfdx version format
  // "1.2.0.LATEST" -> "^1.2.0"
  // "1.2.0.4" -> "^1.2.0"
  // "1.2.0" -> "^1.2.0"
  let versionRange = '*';

  if (dep.versionNumber) {
    const parts = dep.versionNumber.split('.');
    if (parts.length >= 3) {
      const baseVersion = parts.slice(0, 3).join('.');
      versionRange = `^${baseVersion}`;
    }
  }

  return [npmPackageName, versionRange];
}
