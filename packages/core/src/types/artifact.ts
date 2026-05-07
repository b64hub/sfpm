/**
 * Represents the version entry in the manifest
 */
export interface ArtifactVersionEntry {
  artifactHash?: string;
  commit?: string;
  generatedAt: number;
  /** For unlocked packages, the 04t... package version ID */
  packageVersionId?: string;
  path: string;
  sourceHash?: string;
}

/**
 * Represents the manifest.json structure for package artifacts.
 * This manifest tracks all versions of a package and their associated metadata.
 */
export interface ArtifactManifest {
  /** Timestamp of last remote registry check (for TTL-based caching) */
  lastCheckedRemote?: number;
  latest: string;
  name: string;
  versions: {
    [version: string]: ArtifactVersionEntry;
  };
}

/**
 * Result of artifact resolution
 */
export interface ResolvedArtifact {
  artifactPath: string;
  packageVersionId?: string;
  source: 'local' | 'remote';
  /** The resolved version string */
  version: string;
  versionEntry: ArtifactVersionEntry;
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
