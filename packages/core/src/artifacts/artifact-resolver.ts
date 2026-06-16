import fs from 'fs-extra';
import {execSync} from 'node:child_process';
import * as semver from 'semver';

import {ArtifactManifest, ArtifactResolutionOptions, ResolvedArtifact} from '../types/artifact.js';
import {ArtifactError} from '../types/errors.js';
import {Logger} from '../types/logger.js';
import {toVersionFormat} from '../utils/version-utils.js';
import {ArtifactRepository} from './artifact-repository.js';
import {RegistryClient} from './registry/index.js';
import {PnpmRegistryClient} from './registry/pnpm-registry-client.js';

/**
 * Default TTL for remote checks in minutes
 */
const DEFAULT_TTL_MINUTES = 60;

/**
 * ArtifactResolver reconciles the local per-package manifest with remote NPM
 * versions to determine the best install target for a package.
 *
 * In the per-package artifact model, the local side is simple: there is at most
 * one artifact on disk, described by a flat manifest. The resolver compares this
 * single local version against remote registry versions.
 *
 * Key behaviors:
 * - Trust the TTL: if lastCheckedRemote is within TTL, use local manifest only
 * - Highest Wins: uses semver to compare the local version against remote versions
 * - Localize Remotes: if a remote version is newer, download and overwrite local
 * - Version pinning: supports exact versions and semver ranges
 *
 * Modes:
 * - Local-only: no registry client, works only with the local artifact
 * - Remote-enabled: with registry client, can fetch from npm/other registries
/**
 * Resolves where downloaded remote artifacts should be extracted.
 * The default implementation uses `node_modules/` (pnpm-compatible).
 * Swap this to change the download cache location (e.g., `.sfpm/packages/`).
 */
export type DownloadTarget = (packageName: string, version: string) => string;

export class ArtifactResolver {
  private downloadTarget?: DownloadTarget;
  private logger?: Logger;
  private registryClient?: RegistryClient;
  private repository: ArtifactRepository;

  constructor(repository: ArtifactRepository, registryClient?: RegistryClient, logger?: Logger, downloadTarget?: DownloadTarget) {
    this.repository = repository;
    this.registryClient = registryClient;
    this.logger = logger;
    this.downloadTarget = downloadTarget;

    if (this.registryClient) {
      this.logger?.debug(`Using registry: ${this.registryClient.getRegistryUrl()}`);
    } else {
      this.logger?.debug('Running in local-only mode (no registry client)');
    }
  }

  /**
   * Create a resolver with the default pnpm-based registry client.
   *
   * @param packageWorkspacePath - Package workspace directory (contains artifacts/)
   * @param options - Optional overrides
   * @param logger - Optional logger
   */
  public static create(
    packageWorkspacePath: string,
    options?: {
      downloadTarget?: DownloadTarget;
      localOnly?: boolean;
      registryClient?: RegistryClient;
    },
    logger?: Logger,
  ): ArtifactResolver {
    const repository = new ArtifactRepository(packageWorkspacePath, logger);

    if (options?.localOnly) {
      return new ArtifactResolver(repository, undefined, logger);
    }

    const registryClient = options?.registryClient ?? new PnpmRegistryClient({
      logger,
      projectDir: packageWorkspacePath,
    });

    return new ArtifactResolver(repository, registryClient, logger, options?.downloadTarget);
  }

  public getRegistryClient(): RegistryClient | undefined {
    return this.registryClient;
  }

  public getRegistryUrl(): string | undefined {
    return this.registryClient?.getRegistryUrl();
  }

  public getRepository(): ArtifactRepository {
    return this.repository;
  }

  public hasRegistryClient(): boolean {
    return Boolean(this.registryClient);
  }

  /**
   * Resolve the best available artifact version for a package.
   *
   * Resolution logic:
   * 1. Read local manifest (single version)
   * 2. If TTL is valid and no forceRefresh, return local if it satisfies the request
   * 3. Check remote registry for available versions
   * 4. Compare local version against remote versions
   * 5. Return local artifact or download from remote
   */
  public async resolve(packageName: string, options: ArtifactResolutionOptions = {}): Promise<ResolvedArtifact> {
    const {forceRefresh = false, includePrerelease = true, ttlMinutes = DEFAULT_TTL_MINUTES, version} = options;

    try {
      const manifest = await this.repository.getManifest();

      // Try cache first if TTL is valid
      if (!forceRefresh) {
        const cached = this.tryResolveFromCache(packageName, manifest, version, ttlMinutes);
        if (cached) return cached;
      }

      // Check remote and resolve
      return await this.resolveWithRemoteCheck(packageName, manifest, version, includePrerelease);
    } catch (error) {
      this.wrapAndThrow(packageName, error, version, {forceRefresh, ttlMinutes});
    }
  }

  // =========================================================================
  // Private — Download
  // =========================================================================

  private async download(packageName: string, version: string): Promise<ResolvedArtifact> {
    if (!this.registryClient) {
      throw new ArtifactError(packageName, 'download', 'Cannot download package in local-only mode', {
        context: {reason: 'No registry client configured'},
        version,
      });
    }

    const artifactsDir = this.repository.getArtifactsDir();
    await fs.ensureDir(artifactsDir);

    try {
      const {tarballPath} = await this.registryClient.downloadPackage(packageName, version, artifactsDir);

      // Localize: store tarball + manifest in per-package artifacts/
      const localized = await this.repository.localizeTarball(tarballPath, packageName, version);

      // Extract to download target (default: node_modules/<packageName>/)
      let contentPath: string;
      if (this.downloadTarget) {
        contentPath = this.downloadTarget(packageName, version);
        await fs.ensureDir(contentPath);
        execSync(`tar -xzf "${localized.artifactPath}" --strip-components=1 -C "${contentPath}"`, {timeout: 60_000});
        this.logger?.debug(`Extracted remote artifact to ${contentPath}`);
      } else {
        // Fallback: extract to artifacts/package/
        contentPath = this.repository.getPackageContentDir();
        await fs.emptyDir(contentPath);
        execSync(`tar -xzf "${localized.artifactPath}" -C "${artifactsDir}"`, {timeout: 60_000});
      }

      return {
        artifactPath: contentPath,
        manifest: localized.manifest,
        packageVersionId: localized.packageVersionId,
        source: 'remote',
        version,
      };
    } catch (error) {
      throw new ArtifactError(packageName, 'extract', 'Failed to download and localize artifact', {
        cause: error instanceof Error ? error : new Error(String(error)),
        context: {artifactsDir},
        version,
      });
    }
  }

  // =========================================================================
  // Private — Local Resolution
  // =========================================================================

  // =========================================================================
  // Private — Remote Resolution
  // =========================================================================

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
      this.logger?.debug(`No remote versions found for ${packageName}: ${error instanceof Error ? error.message : String(error)}`);
      return [];
    }
  }

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

  // =========================================================================
  // Private — Version Selection
  // =========================================================================

  private isTTLExpired(manifest: ArtifactManifest | undefined, ttlMinutes: number): boolean {
    if (!manifest?.lastCheckedRemote) {
      return true;
    }

    const ttlMs = ttlMinutes * 60 * 1000;
    return (Date.now() - manifest.lastCheckedRemote) > ttlMs;
  }

  /**
   * Resolve from local manifest. Returns undefined if local version doesn't
   * satisfy the request.
   */
  private resolveFromLocal(
    packageName: string,
    manifest: ArtifactManifest,
    requestedVersion: string | undefined,
  ): ResolvedArtifact | undefined {
    const localVersion = manifest.version;

    if (requestedVersion && !this.versionSatisfies(localVersion, requestedVersion)) {
      return undefined;
    }

    const artifactPath = this.repository.getPackageContentDir();
    if (!fs.existsSync(artifactPath)) {
      this.logger?.warn(`Build output missing for ${packageName}@${localVersion}: ${artifactPath}`);
      return undefined;
    }

    return {
      artifactPath,
      manifest,
      packageVersionId: manifest.packageVersionId,
      source: 'local',
      version: localVersion,
    };
  }

  private async resolveWithRemoteCheck(
    packageName: string,
    manifest: ArtifactManifest | undefined,
    requestedVersion: string | undefined,
    includePrerelease: boolean,
  ): Promise<ResolvedArtifact> {
    const remoteVersions = await this.fetchRemoteVersions(packageName);

    const localVersion = manifest?.version;

    // Determine the best version from remote (and optionally local)
    const allVersions = localVersion
      ? [...new Set([localVersion, ...remoteVersions])]
      : remoteVersions;

    if (allVersions.length === 0) {
      // No remote versions and no local — nothing to resolve
      if (manifest) {
        // Return local if it exists, even without remote confirmation
        const local = this.resolveFromLocal(packageName, manifest, requestedVersion);
        if (local) {
          await this.repository.updateLastCheckedRemote();
          return local;
        }
      }

      throw new ArtifactError(packageName, 'resolve', 'No versions available locally or remotely', {
        version: requestedVersion,
      });
    }

    const bestVersion = this.selectBestVersion(allVersions, requestedVersion, includePrerelease);
    if (!bestVersion) {
      throw new ArtifactError(packageName, 'resolve', `No matching version found for ${requestedVersion ?? 'latest'}`, {
        context: {localVersion, remoteVersions},
        version: requestedVersion,
      });
    }

    // Is the best version already local?
    if (localVersion && bestVersion === localVersion && this.repository.hasTarball()) {
      await this.repository.updateLastCheckedRemote();
      const local = this.resolveFromLocal(packageName, manifest!, requestedVersion);
      if (local) {
        return local;
      }
    }

    // Best version is remote — download it
    try {
      const result = await this.download(packageName, bestVersion);
      return result;
    } catch (downloadError) {
      this.logger?.warn(`Failed to download ${packageName}@${bestVersion}: ${downloadError instanceof Error ? downloadError.message : String(downloadError)}`);

      // Fallback to local if available and satisfies request
      if (manifest) {
        const fallback = this.resolveFromLocal(packageName, manifest, requestedVersion);
        if (fallback) {
          this.logger?.warn(`Falling back to local version: ${packageName}@${fallback.version}`);
          return fallback;
        }
      }

      throw new ArtifactError(packageName, 'read', `No available artifact for version ${bestVersion}`, {
        context: {localVersion, remoteVersions},
        version: bestVersion,
      });
    }
  }

  // =========================================================================
  // Private — Helpers
  // =========================================================================

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

    // Exact match
    const exactMatch = cleanedVersions.find(v => v.cleaned === cleanedRequested);
    if (exactMatch) {
      return exactMatch.original;
    }

    // Range match
    const semverOptions: semver.RangeOptions = {includePrerelease};
    const isRange = /[\^~><= ]/.test(requestedVersion);

    if (isRange) {
      const satisfying = cleanedVersions
      .filter(v => semver.satisfies(v.cleaned, cleanedRequested, semverOptions))
      .sort((a, b) => semver.rcompare(a.cleaned, b.cleaned));

      return satisfying[0]?.original;
    }

    // Prefix matching (e.g., "1.0" matches "1.0.0-1")
    const prefixMatches = cleanedVersions
    .filter(v => v.original.startsWith(requestedVersion) || v.cleaned.startsWith(cleanedRequested))
    .sort((a, b) => semver.rcompare(a.cleaned, b.cleaned));

    return prefixMatches[0]?.original;
  }

  /**
   * Try to resolve from local cache if TTL is still valid.
   */
  private tryResolveFromCache(
    packageName: string,
    manifest: ArtifactManifest | undefined,
    requestedVersion: string | undefined,
    ttlMinutes: number,
  ): ResolvedArtifact | undefined {
    if (!manifest || this.isTTLExpired(manifest, ttlMinutes)) {
      return undefined;
    }

    const result = this.resolveFromLocal(packageName, manifest, requestedVersion);
    if (!result) {
      return undefined;
    }

    return result;
  }

  /**
   * Check if a local version satisfies a requested version constraint.
   */
  private versionSatisfies(localVersion: string, requestedVersion: string): boolean {
    const cleanedLocal = toVersionFormat(localVersion, 'semver', {resolveTokens: true, strict: false});
    const cleanedRequested = toVersionFormat(requestedVersion, 'semver', {resolveTokens: true, strict: false});

    // Exact match
    if (cleanedLocal === cleanedRequested) {
      return true;
    }

    // Range match
    if (/[\^~><= ]/.test(requestedVersion) && semver.valid(cleanedLocal)) {
      return semver.satisfies(cleanedLocal, cleanedRequested, {includePrerelease: true});
    }

    // Prefix match
    return localVersion.startsWith(requestedVersion) || cleanedLocal.startsWith(cleanedRequested);
  }

  private wrapAndThrow(
    packageName: string,
    error: unknown,
    version: string | undefined,
    context: Record<string, unknown>,
  ): never {
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
