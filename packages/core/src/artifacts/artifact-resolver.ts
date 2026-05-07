import fs from 'fs-extra';
import {EventEmitter} from 'node:events';
import path from 'node:path';
import * as semver from 'semver';

import {ArtifactManifest, ArtifactResolutionOptions, ResolvedArtifact} from '../types/artifact.js';
import {ArtifactError} from '../types/errors.js';
import {Logger} from '../types/logger.js';
import {toVersionFormat} from '../utils/version-utils.js';
import {ArtifactRepository} from './artifact-repository.js';
import {RegistryClient} from './registry/index.js';
import {PnpmRegistryClient} from './registry/pnpm-registry-client.js';

/**
 * Events emitted by the ArtifactResolver
 */
export interface ArtifactResolverEvents {
  'resolve:cache-hit': {packageName: string; timestamp: Date; version: string;};
  'resolve:complete': {packageName: string; registry: 'local' | 'remote'; timestamp: Date; version: string;};
  'resolve:download:complete': {artifactPath: string; packageName: string; timestamp: Date; version: string;};
  'resolve:download:start': {packageName: string; timestamp: Date; version: string;};
  'resolve:error': {error: string; packageName: string; timestamp: Date};
  'resolve:remote-check': {packageName: string; timestamp: Date};
  'resolve:remote-versions': {packageName: string; timestamp: Date; versions: string[];};
  'resolve:start': {packageName: string; timestamp: Date; version?: string;};
}

/**
 * Default TTL for remote checks in minutes
 */
const DEFAULT_TTL_MINUTES = 60;

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
  private registryClient?: RegistryClient;
  private repository: ArtifactRepository;

  /**
   * Create an ArtifactResolver.
   *
   * @param repository - The artifact repository for local storage operations
   * @param registryClient - Optional registry client for remote package operations (omit for local-only mode)
   * @param logger - Optional logger
   */
  constructor(repository: ArtifactRepository, registryClient?: RegistryClient, logger?: Logger) {
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
   * Create a resolver with the default pnpm-based registry client.
   *
   * Registry and auth configuration is handled by pnpm natively —
   * it reads `.npmrc` files (project, user, global), handles scoped
   * registries, auth tokens, and environment variable expansion.
   *
   * @param projectDirectory - Project directory for artifact storage and pnpm config
   * @param logger - Optional logger
   * @param options - Optional overrides
   */
  public static create(
    projectDirectory: string,
    options?: {
      /** Local-only mode - no registry client */
      localOnly?: boolean;
      /** Inject a custom registry client (for testing or alternative package managers) */
      registryClient?: RegistryClient;
    },
    logger?: Logger,
  ): ArtifactResolver {
    const repository = new ArtifactRepository(projectDirectory, logger);

    if (options?.localOnly) {
      return new ArtifactResolver(repository, undefined, logger);
    }

    const registryClient = options?.registryClient ?? new PnpmRegistryClient({
      logger,
      projectDir: projectDirectory,
    });

    return new ArtifactResolver(repository, registryClient, logger);
  }

  /**
   * Get the registry client instance.
   * Returns undefined if running in local-only mode.
   */
  public getRegistryClient(): RegistryClient | undefined {
    return this.registryClient;
  }

  /**
   * Get the currently configured NPM registry URL.
   * Returns undefined if running in local-only mode.
   */
  public getRegistryUrl(): string | undefined {
    return this.registryClient?.getRegistryUrl();
  }

  /**
   * Get the underlying repository for direct access if needed
   */
  public getRepository(): ArtifactRepository {
    return this.repository;
  }

  /**
   * Check if this resolver has a registry client (remote-enabled mode).
   */
  public hasRegistryClient(): boolean {
    return Boolean(this.registryClient);
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
   * @param packageName - Scoped package name of the package to resolve
   * @param options - Resolution options
   * @returns Resolved artifact information
   */
  public async resolve(packageName: string, options: ArtifactResolutionOptions = {}): Promise<ResolvedArtifact> {
    const {forceRefresh = false, includePrerelease = true, ttlMinutes = DEFAULT_TTL_MINUTES, version} = options;

    this.emit('resolve:start', {packageName, timestamp: new Date(), version});

    try {
      const manifest = await this.repository.getManifest(packageName);

      // Try cache first if TTL is valid
      if (!forceRefresh) {
        const cached = await this.tryResolveFromCache(
          packageName,
          manifest,
          version,
          includePrerelease,
          ttlMinutes,
        );
        if (cached) return cached;
      }

      // Check remote and resolve
      return await this.resolveWithRemoteCheck(packageName, manifest, version, includePrerelease);
    } catch (error) {
      this.emitError(packageName, error);
      throw this.wrapError(packageName, error, version, {forceRefresh, ttlMinutes});
    }
  }

  /**
   * Download a package from the registry.
   * Requires a registry client - throws if running in local-only mode.
   */
  private async download(packageName: string, version: string): Promise<ResolvedArtifact> {
    if (!this.registryClient) {
      throw new ArtifactError(packageName, 'download', 'Cannot download package in local-only mode', {
        context: {reason: 'No registry client configured'},
        version,
      });
    }

    this.emit('resolve:download:start', {
      packageName,
      timestamp: new Date(),
      version,
    });

    const versionDir = await this.repository.ensureVersionDir(packageName, version);

    try {
      // Download the package tarball using registry client
      const {tarballPath} = await this.registryClient.downloadPackage(packageName, version, versionDir);

      // Localize tarball (move, update manifest, symlink, lastChecked)
      const localized = await this.repository.localizeTarball(tarballPath, packageName, version);

      this.emit('resolve:download:complete', {
        artifactPath: localized.artifactPath,
        packageName,
        timestamp: new Date(),
        version,
      });

      return {
        artifactPath: localized.artifactPath,
        packageVersionId: localized.packageVersionId,
        source: 'remote',
        version,
        versionEntry: localized.versionEntry,
      };
    } catch (error) {
      // Cleanup on failure
      await this.repository.removeVersion(packageName, version).catch(() => {
        /* ignore cleanup errors */
      });

      throw new ArtifactError(packageName, 'extract', 'Failed to download and localize artifact', {
        cause: error instanceof Error ? error : new Error(String(error)),
        context: {versionDir},
        version,
      });
    }
  }

  /**
   * Emit resolve:complete event
   */
  private emitComplete(packageName: string, version: string, registry: 'local' | 'remote'): void {
    this.emit('resolve:complete', {
      packageName, registry, timestamp: new Date(), version,
    });
  }

  /**
   * Emit resolve:error event
   */
  private emitError(packageName: string, error: unknown): void {
    const errorMessage = error instanceof Error ? error.message : String(error);
    this.emit('resolve:error', {error: errorMessage, packageName, timestamp: new Date()});
  }

  private fallback(
    packageName: string,
    manifest: ArtifactManifest | undefined,
    requestedVersion: string | undefined,
    includePrerelease: boolean,
  ): ResolvedArtifact | undefined {
    const localVersions = manifest ? Object.keys(manifest.versions) : [];
    if (localVersions.length === 0) {
      return undefined;
    }

    const fallbackVersion = manifest!.latest || this.findHighestVersion(localVersions, includePrerelease);
    if (!fallbackVersion || fallbackVersion === requestedVersion) {
      return undefined;
    }

    this.logger?.warn(`Falling back to local version: ${packageName}@${fallbackVersion}`);
    const result = this.resolveFromLocal(packageName, manifest!, fallbackVersion, includePrerelease);

    if (result) {
      this.emitComplete(packageName, result.version, 'local');
    }

    return result;
  }

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
   * Find the best version from combined local and remote versions.
   *
   * @param requestedVersion - Optional specific version or range to match
   * @param localVersions - Versions available locally
   * @param remoteVersions - Versions available on remote registry
   * @param includePrerelease - Whether to include prerelease versions
   * @returns The best matching version and its source location
   */
  private findBestVersion(
    localVersions: string[],
    remoteVersions: string[],
    requestedVersion: string | undefined,
    includePrerelease: boolean = true,
  ): {registry: 'local' | 'remote'; version: string;} {
    if (localVersions.length === 0 && remoteVersions.length === 0) {
      throw new Error('No versions available locally or remotely');
    }

    const allVersions = [...new Set([...localVersions, ...remoteVersions])];
    const bestVersion = this.selectBestVersion(allVersions, requestedVersion, includePrerelease);

    if (!bestVersion) {
      throw new Error(`No matching version found for ${requestedVersion ?? 'latest'}`);
    }

    // Prefer local if available, otherwise it must be remote
    const registry = localVersions.includes(bestVersion) ? 'local' : 'remote';

    return {registry, version: bestVersion};
  }

  /**
   * Find the highest version from a list
   */
  private findHighestVersion(versions: string[], _includePrerelease: boolean): string | undefined {
    if (versions.length === 0) {
      return undefined;
    }

    const sorted = versions
    .map(v => ({cleaned: toVersionFormat(v, 'semver', {resolveTokens: true, strict: false}), original: v}))
    .filter(v => semver.valid(v.cleaned))
    .sort((a, b) => semver.rcompare(a.cleaned, b.cleaned));

    return sorted[0]?.original;
  }

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

  /**
   * Resolve a version from the local manifest
   */
  private resolveFromLocal(
    packageName: string,
    manifest: ArtifactManifest,
    version: string | undefined,
    includePrerelease: boolean,
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
    let {packageVersionId} = versionEntry;
    if (!packageVersionId) {
      packageVersionId = this.repository.extractPackageVersionId(packageName, targetVersion);
    }

    return {
      artifactPath,
      packageVersionId,
      source: 'local',
      version: targetVersion,
      versionEntry,
    };
  }

  /**
   * Resolve artifact from local storage or download from remote.
   *
   * Uses the pre-computed source from findBestVersion to determine whether
   * to resolve locally or download from remote. Falls back to local if
   * download fails.
   *
   * @param packageName - Package name
   * @param manifest - Local manifest (may be undefined)
   * @param resolved - Result from findBestVersion with version and source
   * @param includePrerelease - Whether to include prerelease versions for fallback
   */
  private async resolveOrDownload(
    packageName: string,
    manifest: ArtifactManifest | undefined,
    resolved: {registry: 'local' | 'remote'; version: string;},
    includePrerelease: boolean,
  ): Promise<ResolvedArtifact> {
    const {registry, version} = resolved;

    // Registry is 'local' - resolve from local storage
    if (registry === 'local') {
      await this.repository.updateLastCheckedRemote(packageName);
      const result = this.resolveFromLocal(packageName, manifest!, version, includePrerelease);
      if (result) {
        this.emitComplete(packageName, result.version, 'local');
        return result;
      }

      // Local artifact file might be missing (corrupt state)
      this.logger?.warn(`Local artifact file missing for ${packageName}@${version}`);
    }

    // Registry is 'remote' or local file missing - try download
    if (registry === 'remote' || manifest?.versions[version]) {
      try {
        const result = await this.download(packageName, version);
        this.emitComplete(packageName, result.version, 'remote');
        return result;
      } catch (downloadError) {
        this.logger?.warn(`Failed to download ${packageName}@${version} from registry: ${downloadError instanceof Error ? downloadError.message : String(downloadError)}`);
      }
    }

    const fallbackResult = this.fallback(packageName, manifest, version, includePrerelease);
    if (fallbackResult) {
      return fallbackResult;
    }

    // No version available
    throw new ArtifactError(packageName, 'read', `No available artifact for version ${version}`, {
      context: {
        hasLocalVersions: manifest ? Object.keys(manifest.versions).length > 0 : false,
        registry,
      },
      version,
    });
  }

  /**
   * Resolve by checking remote registry and comparing with local versions.
   */
  private async resolveWithRemoteCheck(
    packageName: string,
    manifest: ArtifactManifest | undefined,
    requestedVersion: string | undefined,
    includePrerelease: boolean,
  ): Promise<ResolvedArtifact> {
    this.emit('resolve:remote-check', {packageName, timestamp: new Date()});
    const remoteVersions = await this.fetchRemoteVersions(packageName);
    this.emit('resolve:remote-versions', {packageName, timestamp: new Date(), versions: remoteVersions});

    let localVersions;
    if (!requestedVersion && manifest?.latest) {
      localVersions = [manifest.latest];
    } else {
      localVersions = manifest ? Object.keys(manifest.versions) : [];
    }

    let resolvedVersion: {registry: 'local' | 'remote'; version: string;};

    try {
      resolvedVersion = this.findBestVersion(localVersions, remoteVersions, requestedVersion, includePrerelease);
      this.logger?.debug(`Best version for ${packageName}: ${resolvedVersion.version} (${resolvedVersion.registry})`);
    } catch (error) {
      this.logger?.warn(`Failed to find best version for ${packageName}@${requestedVersion}: ${error}`);
      throw new ArtifactError(packageName, 'resolve', `No matching version found for ${requestedVersion}`, {
        context: {
          localVersions,
          remoteVersions,
        },
        version: requestedVersion,
      });
    }

    return this.resolveOrDownload(packageName, manifest, resolvedVersion, includePrerelease);
  }

  /**
   * Select the best version from a list based on a version range or exact match
   */
  private selectBestVersion(
    versions: string[],
    requestedVersion: string | undefined,
    includePrerelease: boolean,
  ): string | undefined {
    if (versions.length === 0) {
      return undefined;
    }

    const cleanedVersions = versions
    .map(v => ({cleaned: toVersionFormat(v, 'semver', {resolveTokens: true, strict: false}), original: v}))
    .filter(v => semver.valid(v.cleaned));

    if (cleanedVersions.length === 0) {
      return versions[0];
    }

    if (!requestedVersion) {
      return this.findHighestVersion(versions, includePrerelease);
    }

    const cleanedRequested = toVersionFormat(requestedVersion, 'semver', {resolveTokens: true, strict: false});

    const exactMatch = cleanedVersions.find(v => v.cleaned === cleanedRequested);
    if (exactMatch) {
      return exactMatch.original;
    }

    const semverOptions: semver.RangeOptions = {includePrerelease};
    const isRange = /[\^~><= ]/.test(requestedVersion);

    if (isRange) {
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

  // =========================================================================
  // Private Methods - Remote Registry
  // =========================================================================

  /**
   * Try to resolve from local cache if TTL is still valid.
   */
  private async tryResolveFromCache(
    packageName: string,
    manifest: ArtifactManifest | undefined,
    version: string | undefined,
    includePrerelease: boolean,
    ttlMinutes: number,
  ): Promise<ResolvedArtifact | undefined> {
    if (this.isTTLExpired(manifest, ttlMinutes) || !manifest) {
      return undefined;
    }

    const result = this.resolveFromLocal(packageName, manifest, version, includePrerelease);
    if (!result) {
      return undefined;
    }

    this.emit('resolve:cache-hit', {packageName, timestamp: new Date(), version: result.version});
    this.emitComplete(packageName, result.version, 'local');
    return result;
  }

  /**
   * Wrap error in ArtifactError if not already one
   */
  private wrapError(
    packageName: string,
    error: unknown,
    version: string | undefined,
    context: Record<string, unknown>,
  ): ArtifactError {
    if (error instanceof ArtifactError) {
      throw error;
    }

    throw new ArtifactError(packageName, 'read', 'Failed to resolve artifact', {
      cause: error instanceof Error ? error : new Error(String(error)),
      context,
      version,
    });
  }
}
