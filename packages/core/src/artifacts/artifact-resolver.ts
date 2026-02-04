import path from 'path';
import os from 'os';
import fs from 'fs-extra';
import * as semver from 'semver';
import { EventEmitter } from 'events';

import { Logger } from '../types/logger.js';
import { 
    ArtifactManifest, 
    ResolvedArtifact, 
    ArtifactResolveOptions 
} from '../types/artifact.js';
import { ArtifactError } from '../types/errors.js';
import { ArtifactRepository } from './artifact-repository.js';
import { RegistryClient, NpmRegistryClient, readNpmConfig } from './registry/index.js';

/**
 * Events emitted by the ArtifactResolver
 */
export interface ArtifactResolverEvents {
    'resolve:start': { packageName: string; version?: string; timestamp: Date };
    'resolve:cache-hit': { packageName: string; version: string; timestamp: Date };
    'resolve:remote-check': { packageName: string; timestamp: Date };
    'resolve:remote-versions': { packageName: string; versions: string[]; timestamp: Date };
    'resolve:download:start': { packageName: string; version: string; timestamp: Date };
    'resolve:download:complete': { packageName: string; version: string; artifactPath: string; timestamp: Date };
    'resolve:complete': { packageName: string; version: string; source: 'local' | 'npm'; timestamp: Date };
    'resolve:error': { packageName: string; error: string; timestamp: Date };
}

/**
 * Default TTL for remote checks in minutes
 */
const DEFAULT_TTL_MINUTES = 60;

/**
 * Default NPM registry URL (fallback)
 */
const DEFAULT_NPM_REGISTRY_URL = 'https://registry.npmjs.org';

/**
 * Environment variable for custom NPM registry
 */
const NPM_REGISTRY_ENV_VAR = 'SFPM_NPM_REGISTRY';

/**
 * ArtifactResolver reconciles local manifest.json with remote NPM versions
 * to determine the best "Install Target" for a package.
 * 
 * Key behaviors:
 * - Trust the TTL: If lastCheckedRemote is within TTL and forceRefresh is false, use local manifest only
 * - Highest Wins: Uses semver (with includePrerelease: true) to compare versions
 * - Localize Remotes: If remote version is newer, download and add to local manifest
 * - Idempotency: If version exists locally with matching hashes, skip re-download
 * 
 * Can operate in two modes:
 * - Local-only: No registry client, only works with local artifacts
 * - Remote-enabled: With registry client, can fetch from npm/other registries
 */
export class ArtifactResolver extends EventEmitter {
    private logger?: Logger;
    private repository: ArtifactRepository;
    private registryClient?: RegistryClient;

    /**
     * Create an ArtifactResolver.
     * 
     * @param repository - The artifact repository for local storage operations
     * @param registryClient - Optional registry client for remote package operations (omit for local-only mode)
     * @param logger - Optional logger
     */
    constructor(
        repository: ArtifactRepository,
        registryClient?: RegistryClient,
        logger?: Logger
    ) {
        super();
        this.repository = repository;
        this.registryClient = registryClient;
        this.logger = logger;
        
        if (this.registryClient) {
            this.logger?.debug(`Using registry: ${this.registryClient.getRegistryUrl()}`);
        } else {
            this.logger?.debug('Running in local-only mode (no registry client)');
        }
    }

    /**
     * Create a resolver with default npm registry client.
     * 
     * Registry Resolution Order:
     * 1. Explicit registry URL if provided in options
     * 2. SFPM_NPM_REGISTRY environment variable
     * 3. npm config (.npmrc files) - supports scoped registries
     * 4. Default: https://registry.npmjs.org
     * 
     * Auth Token Resolution (when using npm config):
     * - Reads from .npmrc (project, user, global)
     * - Supports environment variable expansion (${GITHUB_TOKEN})
     * - Handles scoped registry auth (//npm.pkg.github.com/:_authToken)
     * 
     * @param projectDirectory - Project directory for artifact storage and .npmrc lookup
     * @param logger - Optional logger
     * @param options - Optional overrides for registry URL and auth token
     */
    public static create(
        projectDirectory: string,
        logger?: Logger,
        options?: {
            /** Package name for scoped registry lookup */
            packageName?: string;
            /** Explicit registry URL (overrides npm config) */
            registry?: string;
            /** Explicit auth token (overrides npm config) */
            authToken?: string;
            /** Whether to read .npmrc files (default: true) */
            useNpmrc?: boolean;
            /** Local-only mode - no registry client */
            localOnly?: boolean;
        }
    ): ArtifactResolver {
        const repository = new ArtifactRepository(projectDirectory, logger);
        
        // Local-only mode: no registry client
        if (options?.localOnly) {
            return new ArtifactResolver(repository, undefined, logger);
        }
        
        const { registryUrl, authToken } = ArtifactResolver.resolveRegistryConfig(
            projectDirectory, 
            options, 
            logger
        );
        
        const registryClient = new NpmRegistryClient({
            registryUrl,
            authToken,
            logger,
        });

        return new ArtifactResolver(repository, registryClient, logger);
    }

    /**
     * Create a resolver configured for a specific package.
     * 
     * This is the preferred method when you know the package name upfront,
     * as it properly resolves scoped registries (e.g., @myorg packages).
     * 
     * @param projectDirectory - Project directory for artifact storage
     * @param packageName - Package name (used for scoped registry lookup)
     * @param logger - Optional logger
     * @param options - Optional overrides
     */
    public static async createForPackage(
        projectDirectory: string,
        packageName: string,
        logger?: Logger,
        options?: {
            registry?: string;
            authToken?: string;
            localOnly?: boolean;
        }
    ): Promise<ArtifactResolver> {
        const repository = new ArtifactRepository(projectDirectory, logger);
        
        // Local-only mode: no registry client
        if (options?.localOnly) {
            return new ArtifactResolver(repository, undefined, logger);
        }
        
        // Read npm config for this specific package (handles scoped registries)
        const npmConfig = await readNpmConfig(packageName, projectDirectory, logger);
        
        // Options override npm config
        const registryUrl = options?.registry || npmConfig.registry;
        const authToken = options?.authToken || npmConfig.authToken;
        
        if (npmConfig.isScopedRegistry) {
            logger?.debug(`Using scoped registry for ${packageName}: ${registryUrl}`);
        }
        
        const registryClient = new NpmRegistryClient({
            registryUrl,
            authToken,
            logger,
        });

        return new ArtifactResolver(repository, registryClient, logger);
    }

    /**
     * Get the currently configured NPM registry URL.
     * Returns undefined if running in local-only mode.
     */
    public getRegistryUrl(): string | undefined {
        return this.registryClient?.getRegistryUrl();
    }

    /**
     * Check if this resolver has a registry client (remote-enabled mode).
     */
    public hasRegistryClient(): boolean {
        return !!this.registryClient;
    }

    /**
     * Get the registry client instance.
     * Returns undefined if running in local-only mode.
     */
    public getRegistryClient(): RegistryClient | undefined {
        return this.registryClient;
    }

    /**
     * Get the underlying repository for direct access if needed
     */
    public getRepository(): ArtifactRepository {
        return this.repository;
    }


    /**
     * Resolve the best available artifact version for a package.
     * 
     * Resolution logic:
     * 1. Try cache if TTL is valid (unless forceRefresh)
     * 2. Check remote registry for available versions
     * 3. Select best version from combined local + remote
     * 4. Return local artifact or download from remote
     * 
     * @param packageName - Name of the package to resolve
     * @param options - Resolution options
     * @returns Resolved artifact information
     */
    public async resolve(
        packageName: string,
        options: ArtifactResolveOptions = {}
    ): Promise<ResolvedArtifact> {
        const { 
            forceRefresh = false, 
            ttlMinutes = DEFAULT_TTL_MINUTES,
            version,
            includePrerelease = true 
        } = options;

        this.emit('resolve:start', { packageName, version, timestamp: new Date() });

        try {
            const manifest = await this.repository.getManifest(packageName);

            // Try cache first if TTL is valid
            if (!forceRefresh) {
                const cached = await this.tryResolveFromCache(packageName, manifest, version, includePrerelease, ttlMinutes);
                if (cached) return cached;
            }

            // Check remote and resolve
            return await this.resolveWithRemoteCheck(packageName, manifest, version, includePrerelease);

        } catch (error) {
            this.emitError(packageName, error);
            throw this.wrapError(packageName, error, version, { forceRefresh, ttlMinutes });
        }
    }

    /**
     * Try to resolve from local cache if TTL is still valid.
     */
    private async tryResolveFromCache(
        packageName: string,
        manifest: ArtifactManifest | undefined,
        version: string | undefined,
        includePrerelease: boolean,
        ttlMinutes: number
    ): Promise<ResolvedArtifact | undefined> {
        if (this.isTTLExpired(manifest, ttlMinutes) || !manifest) {
            return undefined;
        }

        const result = this.resolveFromLocal(packageName, manifest, version, includePrerelease);
        if (!result) {
            return undefined;
        }

        this.emit('resolve:cache-hit', { packageName, version: result.version, timestamp: new Date() });
        this.emitComplete(packageName, result.version, 'local');
        return result;
    }

    /**
     * Resolve by checking remote registry and comparing with local versions.
     */
    private async resolveWithRemoteCheck(
        packageName: string,
        manifest: ArtifactManifest | undefined,
        version: string | undefined,
        includePrerelease: boolean
    ): Promise<ResolvedArtifact> {
        this.emit('resolve:remote-check', { packageName, timestamp: new Date() });
        
        const remoteVersions = await this.fetchRemoteVersions(packageName);
        this.emit('resolve:remote-versions', { packageName, versions: remoteVersions, timestamp: new Date() });

        const bestVersion = this.findBestVersion(packageName, manifest, remoteVersions, version, includePrerelease);

        return await this.resolveOrDownload(packageName, manifest, bestVersion, includePrerelease);
    }

    /**
     * Find the best version from combined local and remote versions.
     */
    private findBestVersion(
        packageName: string,
        manifest: ArtifactManifest | undefined,
        remoteVersions: string[],
        requestedVersion: string | undefined,
        includePrerelease: boolean
    ): string {
        const localVersions = manifest ? Object.keys(manifest.versions) : [];
        const allVersions = [...new Set([...localVersions, ...remoteVersions])];
        
        const bestVersion = this.selectBestVersion(allVersions, requestedVersion, includePrerelease);
        
        if (!bestVersion) {
            throw new ArtifactError(packageName, 'read', 'No matching version found', {
                version: requestedVersion,
                context: { localVersions, remoteVersions, requestedVersion },
            });
        }

        return bestVersion;
    }

    /**
     * Resolve from local if available, otherwise download from remote.
     */
    private async resolveOrDownload(
        packageName: string,
        manifest: ArtifactManifest | undefined,
        version: string,
        includePrerelease: boolean
    ): Promise<ResolvedArtifact> {
        const isLocalVersion = manifest?.versions[version] !== undefined;
        
        if (isLocalVersion) {
            await this.repository.updateLastCheckedRemote(packageName);
            const result = this.resolveFromLocal(packageName, manifest!, version, includePrerelease);
            if (result) {
                this.emitComplete(packageName, result.version, 'local');
                return result;
            }
        }

        const result = await this.download(packageName, version);
        this.emitComplete(packageName, result.version, 'npm');
        return result;
    }

    /**
     * Emit resolve:complete event
     */
    private emitComplete(packageName: string, version: string, source: 'local' | 'npm'): void {
        this.emit('resolve:complete', { packageName, version, source, timestamp: new Date() });
    }

    /**
     * Emit resolve:error event
     */
    private emitError(packageName: string, error: unknown): void {
        const errorMessage = error instanceof Error ? error.message : String(error);
        this.emit('resolve:error', { packageName, error: errorMessage, timestamp: new Date() });
    }

    /**
     * Wrap error in ArtifactError if not already one
     */
    private wrapError(
        packageName: string,
        error: unknown,
        version: string | undefined,
        context: Record<string, unknown>
    ): ArtifactError {
        if (error instanceof ArtifactError) {
            throw error;
        }

        throw new ArtifactError(packageName, 'read', 'Failed to resolve artifact', {
            version,
            context,
            cause: error instanceof Error ? error : new Error(String(error)),
        });
    }


    // =========================================================================
    // Static Methods - Registry Resolution
    // =========================================================================

    /**
     * Resolve the NPM registry URL from various sources.
     * Resolution order:
     * 1. Explicit registry option
     * 2. SFPM_NPM_REGISTRY environment variable
     * 3. npm config (.npmrc files) with package name for scoped lookup
     * 4. Default: https://registry.npmjs.org
     */
    private static resolveRegistryConfig(
        projectDirectory: string,
        options?: { 
            packageName?: string;
            registry?: string; 
            authToken?: string;
            useNpmrc?: boolean;
        },
        logger?: Logger
    ): { registryUrl: string; authToken?: string } {
        // 1. Explicit option (highest priority)
        if (options?.registry) {
            return {
                registryUrl: ArtifactResolver.normalizeRegistryUrl(options.registry),
                authToken: options.authToken,
            };
        }

        // 2. Environment variable
        const envRegistry = process.env[NPM_REGISTRY_ENV_VAR];
        if (envRegistry) {
            logger?.debug(`Using registry from ${NPM_REGISTRY_ENV_VAR} env var`);
            return {
                registryUrl: ArtifactResolver.normalizeRegistryUrl(envRegistry),
                authToken: options?.authToken,
            };
        }

        // 3. npm config with package name for scoped registry support
        if (options?.useNpmrc !== false && options?.packageName) {
            try {
                // Use sync version here since create() is synchronous
                // eslint-disable-next-line @typescript-eslint/no-require-imports
                const { readNpmConfigSync } = require('./registry/npm-config-reader.js');
                const npmConfig = readNpmConfigSync(options.packageName, projectDirectory, logger);
                return {
                    registryUrl: npmConfig.registry,
                    authToken: options?.authToken || npmConfig.authToken,
                };
            } catch (error) {
                logger?.debug(`Failed to read npm config: ${error}`);
            }
        }

        // 3b. Legacy: simple .npmrc reading (no scope support)
        if (options?.useNpmrc !== false) {
            const npmrcRegistry = ArtifactResolver.readNpmrcRegistry(projectDirectory, logger);
            if (npmrcRegistry) {
                return {
                    registryUrl: ArtifactResolver.normalizeRegistryUrl(npmrcRegistry),
                    authToken: options?.authToken,
                };
            }
        }

        // 4. Default
        return {
            registryUrl: DEFAULT_NPM_REGISTRY_URL,
            authToken: options?.authToken,
        };
    }

    /**
     * Read registry URL from .npmrc files.
     * Checks project-level first, then user-level.
     */
    private static readNpmrcRegistry(projectDirectory: string, logger?: Logger): string | undefined {
        const npmrcLocations = [
            path.join(projectDirectory, '.npmrc'),
            path.join(os.homedir(), '.npmrc'),
        ];

        for (const npmrcPath of npmrcLocations) {
            try {
                if (fs.existsSync(npmrcPath)) {
                    const content = fs.readFileSync(npmrcPath, 'utf-8');
                    const registry = ArtifactResolver.parseNpmrcRegistry(content);
                    if (registry) {
                        logger?.debug(`Using registry from ${npmrcPath}`);
                        return registry;
                    }
                }
            } catch (error) {
                logger?.debug(`Failed to read .npmrc at ${npmrcPath}: ${error instanceof Error ? error.message : String(error)}`);
            }
        }

        return undefined;
    }

    /**
     * Parse registry URL from .npmrc content.
     */
    private static parseNpmrcRegistry(content: string): string | undefined {
        const lines = content.split('\n');
        
        for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith(';')) {
                continue;
            }

            const registryMatch = trimmed.match(/^registry\s*=\s*(.+)$/i);
            if (registryMatch) {
                return registryMatch[1].trim();
            }
        }

        return undefined;
    }

    /**
     * Normalize registry URL (ensure trailing slash is removed)
     */
    private static normalizeRegistryUrl(url: string): string {
        return url.replace(/\/+$/, '');
    }

    // =========================================================================
    // Private Methods - TTL & Cache Logic
    // =========================================================================

    /**
     * Check if the TTL has expired for remote checks
     */
    private isTTLExpired(manifest: ArtifactManifest | undefined, ttlMinutes: number): boolean {
        if (!manifest?.lastCheckedRemote) {
            return true;
        }

        const ttlMs = ttlMinutes * 60 * 1000;
        const elapsed = Date.now() - manifest.lastCheckedRemote;
        
        return elapsed > ttlMs;
    }

    // =========================================================================
    // Private Methods - Local Resolution
    // =========================================================================

    /**
     * Resolve a version from the local manifest
     */
    private resolveFromLocal(
        packageName: string,
        manifest: ArtifactManifest,
        version: string | undefined,
        includePrerelease: boolean
    ): ResolvedArtifact | undefined {
        const versions = Object.keys(manifest.versions);
        
        if (versions.length === 0) {
            return undefined;
        }

        let targetVersion: string | undefined;

        if (version) {
            // Find exact match or best match for version range
            targetVersion = this.selectBestVersion(versions, version, includePrerelease);
        } else {
            // Use latest or find highest version
            targetVersion = manifest.latest || this.findHighestVersion(versions, includePrerelease);
        }

        if (!targetVersion || !manifest.versions[targetVersion]) {
            return undefined;
        }

        const versionEntry = manifest.versions[targetVersion];
        const artifactPath = path.join(this.repository.getArtifactsRoot(), versionEntry.path);

        // Verify artifact exists
        if (!fs.existsSync(artifactPath)) {
            this.logger?.warn(`Artifact file missing for ${packageName}@${targetVersion}: ${artifactPath}`);
            return undefined;
        }

        // Extract packageVersionId from artifact metadata if not in manifest
        let packageVersionId = versionEntry.packageVersionId;
        if (!packageVersionId) {
            packageVersionId = this.repository.extractPackageVersionId(packageName, targetVersion);
        }

        return {
            version: targetVersion,
            artifactPath,
            isRemote: false,
            source: 'local',
            versionEntry,
            packageVersionId,
        };
    }

    // =========================================================================
    // Private Methods - Version Selection
    // =========================================================================

    /**
     * Select the best version from a list based on a version range or exact match
     */
    private selectBestVersion(
        versions: string[],
        requestedVersion: string | undefined,
        includePrerelease: boolean
    ): string | undefined {
        if (versions.length === 0) {
            return undefined;
        }

        // Clean versions for semver comparison
        const cleanedVersions = versions
            .map(v => ({ original: v, cleaned: this.cleanVersion(v) }))
            .filter(v => semver.valid(v.cleaned));

        if (cleanedVersions.length === 0) {
            // Fallback: return first version if none are valid semver
            return versions[0];
        }

        if (!requestedVersion) {
            // No version requested - find highest
            return this.findHighestVersion(versions, includePrerelease);
        }

        const cleanedRequested = this.cleanVersion(requestedVersion);

        // Check for exact match first
        const exactMatch = cleanedVersions.find(v => v.cleaned === cleanedRequested);
        if (exactMatch) {
            return exactMatch.original;
        }

        // Try semver range matching
        const semverOptions: semver.RangeOptions = { includePrerelease };
        
        // Check if it's a range (contains ^, ~, >, <, etc.)
        const isRange = /[\^~><= ]/.test(requestedVersion);
        
        if (isRange) {
            // Find highest version that satisfies the range
            const satisfying = cleanedVersions
                .filter(v => semver.satisfies(v.cleaned, cleanedRequested, semverOptions))
                .sort((a, b) => semver.rcompare(a.cleaned, b.cleaned));
            
            return satisfying[0]?.original;
        }

        // Try prefix matching (e.g., "1.0" matches "1.0.0-1")
        const prefixMatches = cleanedVersions
            .filter(v => v.original.startsWith(requestedVersion) || v.cleaned.startsWith(cleanedRequested))
            .sort((a, b) => semver.rcompare(a.cleaned, b.cleaned));

        return prefixMatches[0]?.original;
    }

    /**
     * Find the highest version from a list
     */
    private findHighestVersion(versions: string[], _includePrerelease: boolean): string | undefined {
        if (versions.length === 0) {
            return undefined;
        }
        
        const sorted = versions
            .map(v => ({ original: v, cleaned: this.cleanVersion(v) }))
            .filter(v => semver.valid(v.cleaned))
            .sort((a, b) => semver.rcompare(a.cleaned, b.cleaned));

        return sorted[0]?.original;
    }

    /**
     * Clean a version string for semver comparison
     * Handles formats like "1.0.0-16" (npm) and "1.0.0.16" (Salesforce)
     */
    private cleanVersion(version: string): string {
        // Already valid semver
        if (semver.valid(version)) {
            return version;
        }

        // Handle Salesforce format: 1.0.0.16 -> 1.0.0-16
        const sfFormat = /^(\d+)\.(\d+)\.(\d+)\.(\d+|NEXT)$/;
        const sfMatch = version.match(sfFormat);
        if (sfMatch) {
            const [, major, minor, patch, build] = sfMatch;
            return build === 'NEXT' ? `${major}.${minor}.${patch}-0` : `${major}.${minor}.${patch}-${build}`;
        }

        return version;
    }

    // =========================================================================
    // Private Methods - Remote Registry
    // =========================================================================

    /**
     * Fetch available versions from the package registry.
     * Returns empty array if no registry client (local-only mode).
     */
    private async fetchRemoteVersions(packageName: string): Promise<string[]> {
        if (!this.registryClient) {
            this.logger?.debug(`Skipping remote version check for ${packageName} (local-only mode)`);
            return [];
        }
        
        try {
            this.logger?.debug(`Fetching versions for ${packageName} from registry`);
            const versions = await this.registryClient.getVersions(packageName);
            this.logger?.debug(`Found ${versions.length} versions for ${packageName}`);
            return versions;
        } catch (error) {
            // Package might not exist on registry - this is not an error for local-only packages
            this.logger?.debug(`No remote versions found for ${packageName}: ${error instanceof Error ? error.message : String(error)}`);
            return [];
        }
    }

    /**
     * Download a package from the registry.
     * Requires a registry client - throws if running in local-only mode.
     */
    private async download(
        packageName: string,
        version: string
    ): Promise<ResolvedArtifact> {
        if (!this.registryClient) {
            throw new ArtifactError(packageName, 'download', 'Cannot download package in local-only mode', {
                version,
                context: { reason: 'No registry client configured' },
            });
        }
        
        this.emit('resolve:download:start', {
            packageName,
            version,
            timestamp: new Date(),
        });

        const versionDir = await this.repository.ensureVersionDir(packageName, version);

        try {
            // Download the package tarball using registry client
            const { tarballPath } = await this.registryClient.downloadPackage(packageName, version, versionDir);

            // Localize tarball (move, update manifest, symlink, lastChecked)
            const localized = await this.repository.localizeTarball(tarballPath, packageName, version);

            this.emit('resolve:download:complete', {
                packageName,
                version,
                artifactPath: localized.artifactPath,
                timestamp: new Date(),
            });

            return {
                version,
                artifactPath: localized.artifactPath,
                isRemote: true,
                source: 'npm',
                versionEntry: localized.versionEntry,
                packageVersionId: localized.packageVersionId,
            };

        } catch (error) {
            // Cleanup on failure
            await this.repository.removeVersion(packageName, version).catch(() => { /* ignore cleanup errors */ });
            
            throw new ArtifactError(packageName, 'extract', 'Failed to download and localize artifact', {
                version,
                context: { versionDir },
                cause: error instanceof Error ? error : new Error(String(error)),
            });
        }
    }
}
