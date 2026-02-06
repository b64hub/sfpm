import { Logger } from '../../types/logger.js';

/**
 * Package metadata returned from a registry
 */
export interface RegistryPackageInfo {
    /** Package name */
    name: string;
    /** All available versions */
    versions: string[];
    /** Latest version tag */
    latest?: string;
    /** Version-specific metadata */
    versionData?: Record<string, RegistryVersionInfo>;
}

/**
 * Version-specific metadata from a registry
 */
export interface RegistryVersionInfo {
    /** Version string */
    version: string;
    /** URL to download the tarball */
    tarballUrl: string;
    /** Tarball SHA integrity hash */
    integrity?: string;
    /** Tarball SHA-1 hash (legacy) */
    shasum?: string;
}

/**
 * Result of downloading a package
 */
export interface DownloadResult {
    /** Path to the downloaded tarball */
    tarballPath: string;
    /** Integrity hash of the downloaded file */
    integrity?: string;
}

/**
 * Configuration for a registry client
 */
export interface RegistryClientConfig {
    /** Registry URL */
    registryUrl: string;
    /** Authentication token (if required) */
    authToken?: string;
    /** Request timeout in milliseconds */
    timeout?: number;
    /** Logger instance */
    logger?: Logger;
}

/**
 * Interface for interacting with package registries.
 * Implementations can support npm, GitHub Packages, Artifactory, etc.
 */
export interface RegistryClient {
    /**
     * Get the registry URL this client is configured for
     */
    getRegistryUrl(): string;

    /**
     * Get available versions for a package
     * @param packageName - Name of the package
     * @returns List of version strings
     */
    getVersions(packageName: string): Promise<string[]>;

    /**
     * Get full package info including version metadata
     * @param packageName - Name of the package
     * @returns Package metadata or undefined if not found
     */
    getPackageInfo(packageName: string): Promise<RegistryPackageInfo | undefined>;

    /**
     * Download a package tarball to a target directory
     * @param packageName - Name of the package
     * @param version - Version to download
     * @param targetDir - Directory to download to
     * @returns Path to the downloaded tarball
     */
    downloadPackage(
        packageName: string,
        version: string,
        targetDir: string
    ): Promise<DownloadResult>;

    /**
     * Check if a package exists in the registry
     * @param packageName - Name of the package
     * @returns True if the package exists
     */
    packageExists(packageName: string): Promise<boolean>;
}
