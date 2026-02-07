import {Connection, Org} from '@salesforce/core';

import SfpmPackage from '../package/sfpm-package.js';
import {
  ArtifactResolveOptions, ResolvedArtifact,
} from '../types/artifact.js';
import {Logger} from '../types/logger.js';
import {InstalledArtifact} from '../types/package.js';
import {soql} from '../utils/soql.js';
import {ArtifactRepository} from './artifact-repository.js';
import {ArtifactResolver} from './artifact-resolver.js';

export interface SfpmArtifact__c {
  Checksum__c: string;
  Commit_Id__c: string;
  Id?: string;
  Name: string;
  Tag__c: string;
  Version__c: string;
}

/**
 * Result of install target resolution.
 * Combines artifact resolution with org installation status.
 */
export interface InstallTarget {
  /** Reason for the install decision */
  installReason: 'already-installed' | 'hash-mismatch' | 'not-installed' | 'version-downgrade' | 'version-upgrade';
  /** Whether installation is needed */
  needsInstall: boolean;
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

export class ArtifactService {
  /** In-memory cache of installed artifacts keyed by package name. Populated by preloadInstalledArtifacts(). */
  private installedArtifactsCache: Map<string, CachedArtifact> | null = null;
  private logger?: Logger;
  private org?: Org;

  constructor(logger?: Logger, org?: Org) {
    this.logger = logger;
    this.org = org;
  }

  /**
   * Clear the installed artifacts cache.
   * Subsequent calls will query the org directly until preloadInstalledArtifacts() is called again.
   */
  public clearCache(): void {
    this.installedArtifactsCache = null;
  }

  public async getInstalledPackages(orderBy: string = 'Name'): Promise<InstalledArtifact[]> {
    if (!this.org) {
      throw new Error('Org connection required for getInstalledPackages');
    }

    try {
      const records = await this.query<SfpmArtifact__c>(
        soql`SELECT ${ARTIFACT_FIELDS.join(', ')} FROM SfpmArtifact__c ORDER BY ${orderBy} ASC`,
        this.org.getConnection(),
        false,
      );

      // Map SfpmArtifact__c records to InstalledArtifact instances
      return records.map(record => ({
        checksum: record.Checksum__c,
        commitId: record.Commit_Id__c,
        name: record.Name,
        tag: record.Tag__c,
        type: undefined,
        version: record.Version__c,
      }));
    } catch {
      this.logger?.warn('Unable to fetch any sfpm artifacts in the org\n'
      	+ '1. sfpm artifact package is not installed in the org\n'
      	+ '2. The required prerequisite object is not deployed to this org\n');
      return [];
    }
  }

  /**
   * Get an ArtifactRepository for the given project directory.
   * Use this for lower-level artifact operations like reading manifests,
   * checking if artifacts exist, getting metadata, etc.
   */
  public getRepository(projectDirectory: string): ArtifactRepository {
    return new ArtifactRepository(projectDirectory, this.logger);
  }

  /**
   * Invalidate a single package from the cache.
   * The next lookup for this package will fall through to a direct query
   * (or use the remaining cached entries for other packages).
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
    if (!this.org) {
      throw new Error('Org connection required for isArtifactInstalled');
    }

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

    const result: {isInstalled: boolean; versionNumber?: string} = {
      isInstalled: false,
    };

    try {
      this.logger?.debug(`Querying for version of ${packageName} in the Org.`);

      const installedArtifacts = await this.query<SfpmArtifact__c>(
        soql`SELECT ${ARTIFACT_FIELDS.join(', ')} FROM SfpmArtifact__c WHERE Name = '${packageName}'`,
        this.org!.getConnection(),
        false,
      );

      if (installedArtifacts.length > 0) {
        const artifact = installedArtifacts[0];
        result.versionNumber = artifact.Version__c;

        result.isInstalled = version ? artifact.Version__c === version : true;
      }
    } catch {
      this.logger?.warn('Unable to fetch sfpm artifacts in the org\n'
      	+ '1. sfpm package is not installed in the org\n'
      	+ '2. The required prerequisite object is not deployed to this org\n');
    }

    return result;
  }

  /**
   * Preload all installed artifact records from the org into an in-memory cache.
   * Call this once before performing multiple package operations to avoid
   * redundant SOQL queries. The cache is keyed by package name for O(1) lookups.
   *
   * Subsequent calls to isArtifactInstalled(), getArtifactRecordId(), and
   * resolveInstallTarget() will use the cached data instead of querying the org.
   */
  public async preloadInstalledArtifacts(): Promise<void> {
    if (!this.org) {
      throw new Error('Org connection required for preloadInstalledArtifacts');
    }

    try {
      const records = await this.query<SfpmArtifact__c>(
        soql`SELECT ${ARTIFACT_FIELDS.join(', ')} FROM SfpmArtifact__c ORDER BY Name ASC`,
        this.org.getConnection(),
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

      this.logger?.debug(`Preloaded ${records.length} installed artifact(s) into cache`);
    } catch {
      this.logger?.warn('Unable to preload installed artifacts — cache will not be used');
      this.installedArtifactsCache = null;
    }
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
   * @param projectDirectory - Root project directory for artifact storage
   * @param packageName - Name of the package to resolve (SFPM package name, not npm name)
   * @param options - Resolution options (version, forceRefresh, npmScope, etc.)
   * @returns InstallTarget with resolved artifact and install decision
   */
  public async resolveInstallTarget(
    projectDirectory: string,
    packageName: string,
    options?: ArtifactResolveOptions & {
      localOnly?: boolean;
      /** npm scope for scoped registry lookup (e.g., "@myorg") */
      npmScope?: string;
    },
  ): Promise<InstallTarget> {
    // Construct the npm package name (with scope if provided)
    const npmPackageName = options?.npmScope
      ? `${options.npmScope}/${packageName}`
      : packageName;

    // 1. Create resolver for this specific package (handles scoped registries)
    const resolver = await ArtifactResolver.createForPackage(
      projectDirectory,
      npmPackageName,
      this.logger,
      {
        localOnly: options?.localOnly,
      },
    );

    // Note: We still use the SFPM package name for local artifact resolution
    // since that's how artifacts are stored locally
    const resolved = await resolver.resolve(packageName, options);
    this.logger?.debug(`Resolved ${packageName} to version ${resolved.version} from ${resolved.source}`);

    // 2. Check org installation status (if org is available)
    let orgStatus: InstallTarget['orgStatus'] = {
      isInstalled: false,
    };

    if (this.org) {
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
      } else {
        const installed = await this.isArtifactInstalled(packageName);
        if (installed.isInstalled) {
          // Get more details about the installed version
          const installedPackages = await this.getInstalledPackages();
          const installedPkg = installedPackages.find(p => p.name === packageName);

          orgStatus = {
            installedSourceHash: installedPkg?.checksum, // Checksum__c stores sourceHash
            installedVersion: installed.versionNumber,
            isInstalled: true,
          };
        }
      }
    }

    // 3. Determine if installation is needed
    const {installReason, needsInstall} = this.determineInstallNeed(
      resolved,
      orgStatus,
    );

    return {
      installReason,
      needsInstall,
      orgStatus,
      packageName,
      resolved,
    };
  }

  /**
   * Create or update an artifact record in the org
   * @param sfpmPackage - Package to create/update artifact for
   * @returns Artifact record ID
   */
  public async upsertArtifact(sfpmPackage: SfpmPackage): Promise<string | undefined> {
    if (!this.org) {
      throw new Error('Org connection required for upsertArtifact');
    }

    try {
      const artifactId = await this.getArtifactRecordId(sfpmPackage.name);

      this.logger?.info(`Existing artifact record id for ${sfpmPackage.name} in Org for ${sfpmPackage.version}: ${artifactId || 'N/A'}`);

      /** eslint-expect-error camelcase */
      const artifactData = {
        Checksum__c: sfpmPackage.sourceHash,
        Commit_Id__c: sfpmPackage.commitId || '',
        Name: sfpmPackage.name,
        Tag__c: sfpmPackage.tag,
        Version__c: sfpmPackage.version,
      };
      /** eslint-expect-error camelcase */
      let resultId: string;

      if (artifactId) {
        // Update existing record
        const result = await this.org
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
        const result = await this.org.getConnection().sobject('SfpmArtifact__c').create(artifactData);
        resultId = Array.isArray(result) ? result[0].id! : result.id!;

        this.logger?.info(`Created new artifact record: ${resultId}`);
      }

      this.logger?.info(`Updated Org with Artifact ${sfpmPackage.name} ${sfpmPackage.apiVersion} ${sfpmPackage.version} ${resultId}`);

      // Update cache entry in-place so subsequent lookups reflect the upsert
      if (this.installedArtifactsCache) {
        this.installedArtifactsCache.set(sfpmPackage.name, {
          checksum: sfpmPackage.sourceHash,
          commitId: sfpmPackage.commitId,
          id: resultId,
          name: sfpmPackage.name,
          tag: sfpmPackage.tag,
          version: sfpmPackage.version,
        });
      }

      return resultId;
    } catch {
      this.logger?.warn('Unable to update sfpm artifacts in the org, skipping updates\n'
      	+ '1. sfpm artifact package is not installed in the org\n'
      	+ '2. The required prerequisite object is not deployed to this org');
      return undefined;
    }
  }

  /**
   * Determine if installation is needed based on resolved artifact and org status.
   */
  private determineInstallNeed(
    resolved: ResolvedArtifact,
    orgStatus: InstallTarget['orgStatus'],
  ): {installReason: InstallTarget['installReason']; needsInstall: boolean;} {
    // Not installed - definitely needs install
    if (!orgStatus.isInstalled) {
      return {installReason: 'not-installed', needsInstall: true};
    }

    // Compare versions
    if (orgStatus.installedVersion !== resolved.version) {
      // Version mismatch - check if upgrade or downgrade
      // For simplicity, we'll just say it needs install if versions differ
      // A more sophisticated approach could use semver comparison
      return {installReason: 'version-upgrade', needsInstall: true};
    }

    // Same version - check source hash if available
    if (resolved.versionEntry.sourceHash && orgStatus.installedSourceHash && resolved.versionEntry.sourceHash !== orgStatus.installedSourceHash) {
      return {installReason: 'hash-mismatch', needsInstall: true};
    }

    // Everything matches
    return {installReason: 'already-installed', needsInstall: false};
  }

  /**
   * Get the Salesforce record ID for an artifact by package name
   * @param packageName - Name of the package
   * @returns Record ID or undefined if not found
   */
  private async getArtifactRecordId(packageName: string): Promise<string | undefined> {
    // Use cache if available
    if (this.installedArtifactsCache) {
      return this.installedArtifactsCache.get(packageName)?.id;
    }

    try {
      const artifacts = await this.query<SfpmArtifact__c>(
        soql`SELECT ${ARTIFACT_FIELDS.join(', ')} FROM SfpmArtifact__c WHERE Name = '${packageName}' LIMIT 1`,
        this.org!.getConnection(),
        false,
      );

      return artifacts.length > 0 ? artifacts[0].Id : undefined;
    } catch {
      return undefined;
    }
  }

  /**
   * Private query helper method - JSforce v3+ handles network retries automatically
   */
  private async query<T>(query: string, conn: Connection, isTooling: boolean): Promise<T[]> {
    const records = isTooling ? (await conn.tooling.query(query)).records : (await conn.query(query)).records;
    return records as T[];
  }
}
