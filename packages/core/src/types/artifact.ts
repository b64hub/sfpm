/**
 * Source context captured at build time and persisted in artifact metadata.
 * Describes the git/VCS state when the artifact was produced.
 */
export interface SfpmPackageSource {
  branch?: string;
  commit?: string;
  repositoryUrl?: string;
  sourceHash?: string;
  tag?: string;
}

/**
 * Per-package artifact manifest (v2).
 *
 * Lives at `<packageWorkspace>/artifacts/manifest.json` alongside `artifact.tgz`.
 * Tracks metadata for the single artifact on disk — version history is managed
 * by Turborepo's content-addressed cache, not by SFPM.
 */
export interface ArtifactManifest {
  /** SHA-256 hash of artifact.tgz */
  artifactHash?: string;
  /** Git commit SHA at build time */
  commit?: string;
  /** Epoch millis when the artifact was generated */
  generatedAt: number;
  /** Timestamp of last remote registry check (for TTL-based caching) */
  lastCheckedRemote?: number;
  /** Scoped package name (e.g. "@b64/my-pkg") */
  name: string;
  /** For unlocked packages, the 04t... subscriber package version ID */
  packageVersionId?: string;
  /** Schema version for forward compatibility */
  schemaVersion: 2;
  /** Whether this artifact was built locally or downloaded from a registry */
  source: 'local' | 'remote';
  /** SHA-256 hash of the package source files */
  sourceHash?: string;
  /** Semver version string (e.g. "1.0.0-3") */
  version: string;
}

/**
 * Result of artifact resolution
 */
export interface ResolvedArtifact {
  artifactPath: string;
  manifest: ArtifactManifest;
  packageVersionId?: string;
  source: 'local' | 'remote';
  /** The resolved version string */
  version: string;
}

/**
 * Options for artifact resolution
 */
export interface ArtifactResolutionOptions {
  /** Force refresh from remote, bypassing TTL cache */
  forceRefresh?: boolean;
  /** Whether to allow pre-release versions */
  includePrerelease?: boolean;
  /** Only use local artifacts, don't check registry */
  localOnly?: boolean;
  /** Time-to-live for cached remote checks in minutes (default: 60) */
  ttlMinutes?: number;
  /** Specific version to resolve (if not provided, resolves latest) */
  version?: string;
}
