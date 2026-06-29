import {Org} from '@salesforce/core';

import ArtifactService from '../artifacts/artifact-service.js';
import {Logger} from '../types/logger.js';
import {InstalledArtifact, PackageType} from '../types/package.js';
import {InstallCheckResult} from './installers/installer-registry.js';
import {VersionInstallable} from './installers/types.js';
import PackageService from './package-service.js';
import SfpmPackage from './sfpm-package.js';

/**
 * Consolidation layer across sfpm artifacts and Salesforce subscriber packages.
 *
 * Merges data from {@link ArtifactService} (sfpm custom object records) and
 * {@link PackageService} (Salesforce packaging SDK) into a unified view.
 *
 * **Not** an install orchestrator — see {@link PackageInstaller} for that.
 * Installers use the manager for `isInstalled()` checks via the singleton.
 */
export default class PackageManager {
  private static instances = new Map<string, PackageManager>();
  private artifactService: ArtifactService;
  private logger?: Logger;
  private packageService: PackageService;

  constructor(
    artifactService: ArtifactService,
    packageService: PackageService,
    logger?: Logger,
  ) {
    this.artifactService = artifactService;
    this.packageService = packageService;
    this.logger = logger;
  }

  // -----------------------------------------------------------------------
  // Singleton — one manager per org, keyed by username.
  // Caches service instances so query-level caches (installed packages,
  // artifacts) survive across callers within the same process.
  // -----------------------------------------------------------------------

  /** Drop the cached instance for an org (e.g. after re-auth). */
  public static clearInstance(targetOrg: Org): void {
    const username = targetOrg.getUsername();
    if (username) {
      this.instances.delete(username);
    }
  }

  /**
   * Get or create a PackageManager for the given org.
   * First call per username creates the instance; subsequent calls return it.
   */
  public static getInstance(targetOrg: Org, logger?: Logger): PackageManager {
    const username = targetOrg.getUsername();
    if (!username) {
      throw new Error('Target org has no username');
    }

    let manager = this.instances.get(username);
    if (!manager) {
      const artifactService = new ArtifactService(targetOrg);
      const packageService = new PackageService(targetOrg, logger);
      manager = new PackageManager(artifactService, packageService, logger);
      this.instances.set(username, manager);
    }

    return manager;
  }

  // -----------------------------------------------------------------------
  // Service accessors
  // -----------------------------------------------------------------------

  /**
   * Return all installed packages: sfpm artifacts merged with subscriber packages.
   *
   * Artifacts tracked by sfpm get `isInstalledBySfpm: true` and are enriched
   * with subscriber version data when a matching 2GP package exists.
   * Subscriber packages without sfpm artifacts are appended separately.
   */
  public async getAllInstalledArtifacts(): Promise<InstalledArtifact[]> {
    try {
      const [artifacts, installedPackages] = await Promise.all([
        this.artifactService.getInstalledPackages('Name'),
        this.packageService.listInstalledPackages(),
      ]);

      const installedArtifacts: InstalledArtifact[] = [];
      const matchedPackageIds = new Set<string>();

      // Pass 1: sfpm artifacts, enriched with subscriber package data
      for (const artifact of artifacts) {
        const installedArtifact: InstalledArtifact = {
          commitId: artifact.sourceVersion,
          isInstalledBySfpm: true,
          name: artifact.name,
          version: artifact.version,
        };

        const matchedPkg = installedPackages.find(pkg => pkg.SubscriberPackage?.Name === artifact.name);

        if (matchedPkg) {
          matchedPackageIds.add(matchedPkg.SubscriberPackageVersionId);
          installedArtifact.subscriberVersionId = matchedPkg.SubscriberPackageVersionId;
          installedArtifact.type = PackageType.Unlocked;
          installedArtifact.isOrgDependent = matchedPkg.SubscriberPackageVersion?.IsOrgDependent ?? false;
        } else {
          installedArtifact.subscriberVersionId = 'N/A';
          installedArtifact.type = PackageType.Source;
        }

        installedArtifacts.push(installedArtifact);
      }

      // Pass 2: subscriber packages not tracked by sfpm
      for (const pkg of installedPackages) {
        if (matchedPackageIds.has(pkg.SubscriberPackageVersionId)) {
          continue;
        }

        const spv = pkg.SubscriberPackageVersion;
        const versionNumber = spv
          ? `${spv.MajorVersion}.${spv.MinorVersion}.${spv.PatchVersion}.${spv.BuildNumber}`
          : 'N/A';

        let type: PackageType;
        if (spv?.IsOrgDependent) {
          type = PackageType.Unlocked;
        } else if (spv?.Package2ContainerOptions === 'Managed') {
          type = PackageType.Managed;
        } else {
          type = PackageType.Unlocked;
        }

        installedArtifacts.push({
          isInstalledBySfpm: false,
          isOrgDependent: spv?.IsOrgDependent ?? false,
          name: pkg.SubscriberPackage?.Name ?? 'N/A',
          subscriberVersionId: pkg.SubscriberPackageVersionId,
          type,
          version: versionNumber,
        });
      }

      return installedArtifacts;
    } catch {
      this.logger?.warn('Unable to fetch all installed artifacts, returning empty list');
      return [];
    }
  }

  public getArtifactService(): ArtifactService {
    return this.artifactService;
  }

  // -----------------------------------------------------------------------
  // Install checks
  // -----------------------------------------------------------------------

  public getPackageService(): PackageService {
    return this.packageService;
  }

  // -----------------------------------------------------------------------
  // Query — merged view
  // -----------------------------------------------------------------------

  /**
   * Check whether a package is already installed in the target org.
   *
   * Combines two checks:
   * 1. **Artifact check** — if it's an SfpmPackage, compare source hash against the sfpm artifact record
   * 2. **Version check** — if it has a `packageVersionId`, check whether that 04t is installed
   *
   * Either check succeeding means the package doesn't need installation.
   */
  public async isInstalled(sfpmPackage: SfpmPackage | VersionInstallable): Promise<InstallCheckResult> {
    // Check 1: artifact hash match (sfpm-managed packages only)
    if (sfpmPackage instanceof SfpmPackage) {
      const artifactResult = await this.isArtifactInstalled(sfpmPackage.name, sfpmPackage.sourceHash);
      if (!artifactResult.needsInstall) {
        return artifactResult;
      }
    }

    // Check 2: subscriber package version match (unlocked / managed)
    const versionId = isVersionInstallable(sfpmPackage) ? sfpmPackage.packageVersionId : undefined;
    if (versionId) {
      return this.isPackageVersionInstalled(versionId);
    }

    return {installReason: 'not-installed', needsInstall: true};
  }

  // -----------------------------------------------------------------------
  // Private
  // -----------------------------------------------------------------------

  private async isArtifactInstalled(name: string, sourceHash?: string): Promise<InstallCheckResult> {
    try {
      if (sourceHash) {
        const installedArtifacts = await this.artifactService.getInstalledPackages();
        const installed = installedArtifacts.find(a => a.name === name);

        if (installed?.checksum && installed.checksum === sourceHash) {
          this.logger?.debug(`Package ${name} already installed with matching hash ${sourceHash}`);
          return {installReason: 'hash-match', needsInstall: false};
        }
      }
    } catch (error) {
      const err = error instanceof Error ? error.message : String(error);
      this.logger?.warn(`Unable to check if ${name} is installed, proceeding with install: ${err}`);
      return {installReason: 'check-failed', needsInstall: true};
    }

    return {installReason: 'not-installed', needsInstall: true};
  }

  private async isPackageVersionInstalled(packageVersionId: string): Promise<InstallCheckResult> {
    try {
      const isVersionInstalled = await this.packageService.isSubscriberVersionInstalled(packageVersionId);
      if (isVersionInstalled) {
        this.logger?.debug(`Package version ${packageVersionId} already installed`);
        return {installReason: 'version-installed', needsInstall: false};
      }
    } catch (error) {
      const err = error instanceof Error ? error.message : String(error);
      this.logger?.warn(`Unable to check if ${packageVersionId} is installed, proceeding with install: ${err}`);
      return {installReason: 'check-failed', needsInstall: true};
    }

    return {installReason: 'not-installed', needsInstall: true};
  }
}

// ---------------------------------------------------------------------------
// Type guard — VersionInstallable is an interface, not a class
// ---------------------------------------------------------------------------

function isVersionInstallable(value: unknown): value is VersionInstallable {
  return (
    typeof value === 'object'
    && value !== null
    && 'packageVersionId' in value
    && typeof (value as VersionInstallable).packageVersionId === 'string'
  );
}
