import {Connection, Org} from '@salesforce/core';
import path from 'node:path';

import SfpmPackage from '../package/sfpm-package.js';
import {
  ArtifactResolutionOptions, ResolvedArtifact, SfpmPackageSource,
} from '../types/artifact.js';
import {Logger} from '../types/logger.js';
import {InstalledArtifact} from '../types/package.js';
import {getPipelineRunId} from '../utils/pipeline.js';
import {soql} from '../utils/soql.js';
import {ArtifactRepository} from './artifact-repository.js';
import {ArtifactResolver, DownloadTarget} from './artifact-resolver.js';

export interface SfpmArtifact__c {
  Checksum__c: string;
  Commit_Id__c: string;
  Id?: string;
  Name: string;
  Tag__c: string;
  Version__c: string;
}

/**
 * Record shape for the optional `Sfpm_Artifact_History__c` custom object.
 * Created each time an artifact is installed/updated when history tracking is enabled.
 * Uses standard `CreatedDate` for timestamping (auto-populated by Salesforce).
 */

export interface SfpmArtifactHistory__c {
  Checksum__c: string;
  Commit_Id__c: string;
  Deploy_Id__c?: string;
  Name: string;
  Pipeline_Run_Id__c?: string;
  Tag__c: string;
  Version__c: string;
}

/**
 * Options for creating an artifact history record.
 */
export interface ArtifactHistoryOptions {
  /** Salesforce deploy ID or PackageInstallRequest ID */
  deployId?: string;
}

/**
 * Result of artifact resolution against the target org.
 * Combines the resolved artifact with the org's current installation status.
 * The install decision is made by the installer's `isInstalled()` method,
 * not by the artifact service.
 */
export interface ArtifactResolution {
  /** Current installation status in the org */
  orgStatus: {
    /** The currently installed sourceHash (if any) */
    installedSourceHash?: string;
    /** The currently installed version (if any) */
    installedVersion?: string;
    /** Whether the package is currently installed */
    isInstalled: boolean;
  };
  /** The package name */
  packageName: string;
  /** The resolved artifact to install */
  resolved: ResolvedArtifact;
}

const ARTIFACT_FIELDS = ['Id', 'Name', 'Tag__c', 'Version__c', 'Commit_Id__c', 'Checksum__c'];

/**
 * Cached representation of an installed artifact record, including the Salesforce record Id.
 */
interface CachedArtifact {
  checksum?: string;
  commitId?: string;
  id?: string;
  name: string;
  tag?: string;
  version?: string;
}

export default class ArtifactService {
  /** Singleton instance for shared cache across operations */
  private static instance?: ArtifactService;
  /** Whether the artifact object is available in the org. Starts true, flipped to false on first failure. */
  private artifactAvailable = true;
  /** Track if we've attempted to load the cache (even if it failed) to avoid repeated attempts */
  private cacheLoadAttempted = false;
  /** Whether the history object is available in the org. Starts true, flipped to false on first failure. */
  private historyAvailable = true;
  /** In-memory cache of installed artifacts keyed by package name. Lazy-loaded on first access. */
  private installedArtifactsCache: Map<string, CachedArtifact> | null = null;
  private logger?: Logger;
  private projectDir?: string;
  private targetOrg?: Org;

  constructor(targetOrg: Org, logger?: Logger) {
    this.logger = logger;
    this.targetOrg = targetOrg;
  }

  /**
   * Get the singleton instance of ArtifactService.
   * Use this to share the preloaded cache across multiple operations.
   *
   * @example
   * ```typescript
   * const service = ArtifactService.getInstance();
   * service.setOrg(org);
   * service.setLogger(logger);
   *
   * // Later, in other classes:
   * const service = ArtifactService.getInstance(); // Same instance with cache
   * ```
   */
  public static getInstance(): ArtifactService {
    if (!ArtifactService.instance) {
      ArtifactService.instance = new ArtifactService();
    }

    return ArtifactService.instance;
  }

  /**
   * Reset the singleton instance (primarily for testing).
   * This clears the cached instance, allowing a fresh start.
   */
  public static resetInstance(): void {
    ArtifactService.instance = undefined;
  }

  /**
   * Clear the installed artifacts cache.
   * The cache will be reloaded on next access (lazy loading).
   */
  public clearCache(): void {
    this.installedArtifactsCache = null;
    this.cacheLoadAttempted = false;
    this.artifactAvailable = true;
    this.historyAvailable = true;
  }

  /**
   * Create an `Sfpm_Artifact_History__c` record in the target org.
   *
   * Called automatically after every artifact upsert.
   * Degrades gracefully — if the custom object is not deployed to the target org
   * the error is caught and a warning is logged.
   *
   * @param sfpmPackage - Package that was just installed/updated
   * @param options - Optional context: deployId from the Salesforce deployment
   * @returns Record ID of the created history record, or undefined on failure
   */
  public async createHistoryRecord(
    sfpmPackage: SfpmPackage,
    options?: ArtifactHistoryOptions,
    source?: SfpmPackageSource,
  ): Promise<string | undefined> {
    if (!this.targetOrg) {
      throw new Error('Org connection required for createHistoryRecord');
    }

    if (!this.historyAvailable) {
      return undefined;
    }

    try {
      /* eslint-disable camelcase */
      const historyData: SfpmArtifactHistory__c = {
        Checksum__c: source?.sourceHash || '',
        Commit_Id__c: source?.commit || '',
        Deploy_Id__c: options?.deployId,
        Name: sfpmPackage.name,
        Pipeline_Run_Id__c: getPipelineRunId(),
        Tag__c: source?.tag || `${sfpmPackage.name}@${sfpmPackage.version}`,
        Version__c: sfpmPackage.version || '',
      };
      /* eslint-enable camelcase */

      const result = await this.targetOrg
      .getConnection()
      .sobject('Sfpm_Artifact_History__c')
      .create(historyData);
      const resultId = Array.isArray(result) ? result[0].id! : result.id!;

      this.logger?.info(`Created artifact history record for ${sfpmPackage.name}@${sfpmPackage.version}: ${resultId}`);
      return resultId;
    } catch (error) {
      this.historyAvailable = false;
      const message = error instanceof Error ? error.message : String(error);
      this.logger?.debug(`Sfpm_Artifact_History__c is not available in this org — skipping history tracking: ${message}`);
      return undefined;
    }
  }

  /**
   * Get the build output directory for a package, if a build exists.
   *
   * Checks for a `dist/package.json` in the package workspace.
   * Returns the path to `dist/` (the deployable content) or
   * `undefined` if no build has been run.
   *
   * @param packageWorkspacePath - Package workspace root
   * @returns Absolute path to `dist/` or undefined
   */
  public getBuildOutput(packageWorkspacePath: string): string | undefined {
    const repo = this.getRepository(packageWorkspacePath);
    if (!repo.hasArtifact()) return undefined;
    return repo.getDistDir();
  }

  public async getInstalledPackages(orderBy: string = 'Name'): Promise<InstalledArtifact[]> {
    if (!this.targetOrg) {
      throw new Error('Org connection required for getInstalledPackages');
    }

    // Use cache if available (lazy-loaded)
    await this.ensureCacheLoaded();

    if (this.installedArtifactsCache) {
      // Convert cache to InstalledArtifact array and sort
      // Filter out entries without version (shouldn't happen but be defensive)
      const packages = [...this.installedArtifactsCache.values()]
      .filter(cached => cached.version !== undefined)
      .map(cached => ({
        checksum: cached.checksum,
        commitId: cached.commitId,
        name: cached.name,
        tag: cached.tag,
        type: undefined,
        version: cached.version!,
      }));

      // Sort by requested field
      if (orderBy === 'Name') {
        packages.sort((a, b) => a.name.localeCompare(b.name));
      }

      return packages;
    }

    return [];
  }

  /**
   * Get an ArtifactRepository for the given package workspace path.
   * Use this for lower-level artifact operations like checking if builds exist,
   * getting metadata, reading dist/package.json, etc.
   */
  public getRepository(packageWorkspacePath: string, packageName?: string): ArtifactRepository {
    return new ArtifactRepository(packageWorkspacePath, this.logger, packageName);
  }

  /**
   * Invalidate a single package from the cache.
   * The package will be removed from cache but cache remains active.
   * Use clearCache() to force a full cache reload.
   */
  public invalidatePackage(packageName: string): void {
    this.installedArtifactsCache?.delete(packageName);
  }

  /**
   * Check whether an artifact is installed in the org
   * @param packageName - Name of the package to check
   * @param version - Optional version to check for exact match
   * @returns Object with isInstalled flag and versionNumber if found
   */
  public async isArtifactInstalled(
    packageName: string,
    version?: string,
  ): Promise<{isInstalled: boolean; versionNumber?: string}> {
    if (!this.targetOrg) {
      throw new Error('Org connection required for isArtifactInstalled');
    }

    // Ensure cache is loaded (lazy loading)
    await this.ensureCacheLoaded();

    // Use cache if available
    if (this.installedArtifactsCache) {
      const cached = this.installedArtifactsCache.get(packageName);
      if (!cached) {
        return {isInstalled: false};
      }

      if (version) {
        return {isInstalled: cached.version === version, versionNumber: cached.version};
      }

      return {isInstalled: true, versionNumber: cached.version};
    }

    // Cache load failed or not available
    return {isInstalled: false};
  }

  /**
   * Resolve the install target for a package.
   *
   * This is the main orchestration method that:
   * 1. Resolves the best available artifact (local or from npm registry)
   * 2. Checks what's currently installed in the target org
   * 3. Determines if installation is needed and why
   *
   * Uses npm config (.npmrc) for registry and auth token resolution,
   * including support for scoped registries (e.g., @myorg packages).
   *
   * @param packageWorkspacePath - Package workspace directory (contains artifacts/)
   * @param packageName - Fully scoped name of the package to resolve
   * @param options - Resolution options (version, forceRefresh, etc.)
   * @returns ArtifactResolution with resolved artifact and org status
   */
  public async resolveArtifact(
    packageWorkspacePath: string,
    packageName: string,
    options?: ArtifactResolutionOptions,
  ): Promise<ArtifactResolution> {
    // 1. Create resolver for this specific package (handles scoped registries)
    const downloadTarget: DownloadTarget | undefined = this.projectDir
      ? pkgName => path.join(this.projectDir!, 'node_modules', pkgName)
      : undefined;

    const resolver = ArtifactResolver.create(
      packageWorkspacePath,
      {
        downloadTarget,
        localOnly: options?.localOnly,
      },
      this.logger,
    );

    // Note: We still use the SFPM package name for local artifact resolution
    // since that's how artifacts are stored locally
    const resolved = await resolver.resolve(packageName, options);
    this.logger?.debug(`Resolved ${packageName} to version ${resolved.version} from ${resolved.source}`);

    // 2. Check org installation status (if org is available)
    let orgStatus: ArtifactResolution['orgStatus'] = {
      isInstalled: false,
    };

    if (this.targetOrg) {
      // Ensure cache is loaded (lazy loading)
      await this.ensureCacheLoaded();

      // When cache is available, a single map lookup replaces 2+ SOQL queries
      if (this.installedArtifactsCache) {
        const cached = this.installedArtifactsCache.get(packageName);
        if (cached) {
          orgStatus = {
            installedSourceHash: cached.checksum,
            installedVersion: cached.version,
            isInstalled: true,
          };
        }
      }
    }

    return {
      orgStatus,
      packageName,
      resolved,
    };
  }

  /**
   * Set the logger for this service instance.
   * Useful when using the singleton pattern to configure after getInstance().
   */
  public setLogger(logger: Logger | undefined): this {
    this.logger = logger;
    return this;
  }

  /**
   * Set the org for this service instance.
   * Useful when using the singleton pattern to configure after getInstance().
   */
  public setOrg(org: Org | undefined): this {
    this.targetOrg = org;
    return this;
  }

  /**
   * Set the project root directory.
   * Used to resolve the download target for remote artifacts (e.g., `node_modules/`).
   */
  public setProjectDir(projectDir: string): this {
    this.projectDir = projectDir;
    return this;
  }

  /**
   * Create or update an artifact record in the org
   * @param sfpmPackage - Package to create/update artifact for
   * @returns Artifact record ID
   */
  public async upsertArtifact(sfpmPackage: SfpmPackage, source?: SfpmPackageSource): Promise<string | undefined> {
    if (!this.targetOrg) {
      throw new Error('Org connection required for upsertArtifact');
    }

    if (!this.artifactAvailable) {
      return undefined;
    }

    try {
      const artifactId = await this.getArtifactRecordId(sfpmPackage.name);

      this.logger?.info(`Existing artifact record id for ${sfpmPackage.name} in Org for ${sfpmPackage.version}: ${artifactId || 'N/A'}`);

      /* eslint-disable camelcase */
      const artifactData = {
        Checksum__c: source?.sourceHash,
        Commit_Id__c: source?.commit || '',
        Name: sfpmPackage.name,
        Tag__c: source?.tag || `${sfpmPackage.name}@${sfpmPackage.version}`,
        Version__c: sfpmPackage.version,
      };
      /* eslint-enable camelcase */
      let resultId: string;

      if (artifactId) {
        // Update existing record
        const result = await this.targetOrg
        .getConnection()
        .sobject('SfpmArtifact__c')
        .update({
          Id: artifactId,
          ...artifactData,
        });
        resultId = Array.isArray(result) ? result[0].id! : result.id!;

        this.logger?.info(`Updated artifact record: ${resultId}`);
      } else {
        // Create new record
        const result = await this.targetOrg.getConnection().sobject('SfpmArtifact__c').create(artifactData);
        resultId = Array.isArray(result) ? result[0].id! : result.id!;

        this.logger?.info(`Created new artifact record: ${resultId}`);
      }

      this.logger?.info(`Updated Org with Artifact ${sfpmPackage.name} ${sfpmPackage.apiVersion} ${sfpmPackage.version} ${resultId}`);

      // Update cache entry in-place so subsequent lookups reflect the upsert
      if (this.installedArtifactsCache) {
        this.installedArtifactsCache.set(sfpmPackage.name, {
          checksum: source?.sourceHash,
          commitId: source?.commit,
          id: resultId,
          name: sfpmPackage.name,
          tag: source?.tag || `${sfpmPackage.name}@${sfpmPackage.version}`,
          version: sfpmPackage.version,
        });
      }

      return resultId;
    } catch (error) {
      this.artifactAvailable = false;
      const message = error instanceof Error ? error.message : String(error);
      this.logger?.debug(`SfpmArtifact__c is not available in this org — skipping artifact tracking: ${message}`);
      return undefined;
    }
  }

  /**
   * Ensure the artifact cache is loaded.
   * This implements lazy loading - loads cache on first access and caches result.
   * Subsequent calls are no-ops unless cache is cleared.
   */
  private async ensureCacheLoaded(): Promise<void> {
    // Already loaded or already attempted
    if (this.installedArtifactsCache !== null || this.cacheLoadAttempted) {
      return;
    }

    // Mark as attempted to prevent repeated failures
    this.cacheLoadAttempted = true;

    if (!this.targetOrg) {
      this.logger?.debug('No org connection available - skipping cache load');
      return;
    }

    try {
      const records = await this.query<SfpmArtifact__c>(
        soql`SELECT ${ARTIFACT_FIELDS.join(', ')} FROM SfpmArtifact__c ORDER BY Name ASC`,
        this.targetOrg.getConnection(),
        false,
      );

      this.installedArtifactsCache = new Map();
      for (const record of records) {
        this.installedArtifactsCache.set(record.Name, {
          checksum: record.Checksum__c,
          commitId: record.Commit_Id__c,
          id: record.Id,
          name: record.Name,
          tag: record.Tag__c,
          version: record.Version__c,
        });
      }

      this.logger?.debug(`Lazy-loaded ${records.length} installed artifact(s) into cache`);
    } catch {
      this.logger?.debug('Unable to load installed artifacts cache - queries will not be cached');
      this.installedArtifactsCache = null;
    }
  }

  /**
   * Get the Salesforce record ID for an artifact by package name
   * @param packageName - Name of the package
   * @returns Record ID or undefined if not found
   */
  private async getArtifactRecordId(packageName: string): Promise<string | undefined> {
    // Ensure cache is loaded (lazy loading)
    await this.ensureCacheLoaded();

    // Use cache if available
    if (this.installedArtifactsCache) {
      return this.installedArtifactsCache.get(packageName)?.id;
    }

    return undefined;
  }

  /**
   * Private query helper method - JSforce v3+ handles network retries automatically
   */
  private async query<T>(query: string, conn: Connection, isTooling: boolean): Promise<T[]> {
    const records = isTooling ? (await conn.tooling.query(query)).records : (await conn.query(query)).records;
    return records as T[];
  }
}
