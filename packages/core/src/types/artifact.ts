/**
 * Represents the version entry in the manifest
 */
export interface ArtifactVersionEntry {
    path: string;
    sourceHash?: string;
    artifactHash?: string;
    generatedAt: number;
    commit?: string;
    /** For unlocked packages, the 04t... package version ID */
    packageVersionId?: string;
}

/**
 * Represents the manifest.json structure for package artifacts.
 * This manifest tracks all versions of a package and their associated metadata.
 */
export interface ArtifactManifest {
    name: string;
    latest: string;
    /** Timestamp of last remote registry check (for TTL-based caching) */
    lastCheckedRemote?: number;
    versions: {
        [version: string]: ArtifactVersionEntry;
    };
}

/**
 * Result of artifact resolution
 */
export interface ResolvedArtifact {
    /** The resolved version string */
    version: string;
    artifactPath: string;
    source: 'local' | 'remote';
    versionEntry: ArtifactVersionEntry;
    packageVersionId?: string;
}

/**
 * Options for artifact resolution
 */
export interface ArtifactResolveOptions {
    /** Force refresh from remote, bypassing TTL cache */
    forceRefresh?: boolean;
    /** Time-to-live for cached remote checks in minutes (default: 60) */
    ttlMinutes?: number;
    /** Specific version to resolve (if not provided, resolves latest) */
    version?: string;
    /** Whether to allow pre-release versions */
    includePrerelease?: boolean;
}
