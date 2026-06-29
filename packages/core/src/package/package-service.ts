import {
  Connection, Lifecycle, Org, SfProject,
} from '@salesforce/core';
import {Duration, env} from '@salesforce/kit';
import {
  INSTALL_URL_BASE,
  InstalledPackages,
  Package,
  PackageCreateOptions,
  PackageEvents,
  PackageInstallCreateRequest,
  PackageInstallOptions,
  PackageSaveResult,
  PackageVersion,
  PackageVersionCreateReportProgress,
  PackageVersionCreateRequestResult,
  PackageVersionEvents,
  PackageVersionListOptions,
  PackageVersionListResult,
  PackageVersionReportResult,
  PackageVersionUpdateOptions,
  PackagingSObjects,
  SubscriberPackageVersion,
} from '@salesforce/packaging';

import {Logger} from '../types/logger.js';
import {soql} from '../utils/soql.js';

import Package2VersionStatus = PackagingSObjects.Package2VersionStatus;

// ---------------------------------------------------------------------------
// Types — SDK re-exports + thin types for raw SOQL results
// ---------------------------------------------------------------------------

/** Re-export SDK type for backward compat */
export type Package2 = PackagingSObjects.Package2;

/** Shape returned by direct Package2Version tooling SOQL queries */
export interface Package2Version {
  Branch: string;
  BuildNumber: number;
  CodeCoverage: {apexCodeCoveragePercentage: number};
  HasPassedCodeCoverageCheck: boolean;
  IsPasswordProtected: boolean;
  IsReleased: boolean;
  MajorVersion: number;
  MinorVersion: number;
  Package2: Package2;
  Package2Id: string;
  PatchVersion: number;
  SubscriberPackageVersionId: string;
}

// Maps command-level values to PackageInstallRequest wire values (same as CLI)
const SECURITY_TYPE_MAP: Record<string, PackageInstallCreateRequest['SecurityType']> = {
  AdminsOnly: 'none' as PackageInstallCreateRequest['SecurityType'],
  AllUsers: 'full' as PackageInstallCreateRequest['SecurityType'],
};
const UPGRADE_TYPE_MAP: Record<string, PackageInstallCreateRequest['UpgradeType']> = {
  Delete: 'delete-only' as PackageInstallCreateRequest['UpgradeType'],
  DeprecateOnly: 'deprecate-only' as PackageInstallCreateRequest['UpgradeType'],
  Mixed: 'mixed-mode' as PackageInstallCreateRequest['UpgradeType'],
};

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export {PackageService};
export default class PackageService {
  private static readonly PACKAGE2_VERSION_FIELDS = [
    'SubscriberPackageVersionId',
    'Package2Id',
    'Package2.Name',
    'IsPasswordProtected',
    'IsReleased',
    'MajorVersion',
    'MinorVersion',
    'PatchVersion',
    'BuildNumber',
    'CodeCoverage',
    'HasPassedCodeCoverageCheck',
    'Branch',
  ];
  private devhub?: Org;
  /** Cached installed packages. Populated by {@link preloadInstalledPackages}. */
  private installedCache?: InstalledPackages[];
  private logger?: Logger;
  private targetOrg?: Org;

  constructor(targetOrg: Org, logger?: Logger) {
    this.connect(targetOrg);
    this.logger = logger;
  }

  // -----------------------------------------------------------------------
  // Connection
  // -----------------------------------------------------------------------

  /**
   * Clear the installed packages cache.
   */
  public clearCache(): void {
    this.installedCache = undefined;
  }

  public connect(targetOrg: Org): void {
    this.targetOrg = targetOrg;
    this.clearCache();
  }

  // -----------------------------------------------------------------------
  // Package — Create
  // -----------------------------------------------------------------------

  public connectDevhub(devhub: Org): void {
    if (!devhub.isDevHubOrg()) {
      throw new Error('Only a devhub org can be connected as a devhub');
    }

    this.devhub = devhub;
  }

  // -----------------------------------------------------------------------
  // Package — Update
  // -----------------------------------------------------------------------

  /**
   * Create a new 2GP package in the DevHub.
   *
   * @param name        - Package name — required
   * @param packageType - 'Managed' or 'Unlocked' — required
   * @param path        - Path to the package directory — required
   * @param options     - Additional creation options
   */
  public async createPackage(
    name: string,
    packageType: 'Managed' | 'Unlocked',
    path: string,
    options?: {
      description?: string;
      errorNotificationUsername?: string;
      noNamespace?: boolean;
      orgDependent?: boolean;
      projectPath?: string;
    },
  ): Promise<{Id: string}> {
    const connection = this.requireDevhubConnection();
    const project = await SfProject.resolve(options?.projectPath);

    const createOptions: PackageCreateOptions = {
      description: options?.description ?? '',
      errorNotificationUsername: options?.errorNotificationUsername as string,
      name,
      noNamespace: options?.noNamespace ?? false,
      orgDependent: options?.orgDependent ?? false,
      packageType,
      path,
    };

    const result = await Package.create(connection, project, createOptions);
    this.logger?.info(`Package created: ${result.Id}`);
    return result;
  }

  // -----------------------------------------------------------------------
  // Package — Delete
  // -----------------------------------------------------------------------

  /**
   * Create a new package version.
   *
   * Wraps `PackageVersion.create()` from the SDK.
   *
   * @param packageId  - Package ID (0Ho) or alias — required
   * @param options    - Version creation options (all optional, see SDK PackageVersionCreateOptions)
   * @param onProgress - Called with progress updates during polling
   */
  public async createPackageVersion(
    packageId: string,
    options?: {
      apiVersion?: string;
      asyncvalidation?: boolean;
      branch?: string;
      codecoverage?: boolean;
      definitionfile?: string;
      installationkey?: string;
      installationkeybypass?: boolean;
      path?: string;
      postinstallscript?: string;
      postinstallurl?: string;
      /** Path to the project directory to resolve sfdx-project.json from (e.g. a dist/ build dir) */
      projectPath?: string;
      releasenotesurl?: string;
      skipancestorcheck?: boolean;
      skipvalidation?: boolean;
      tag?: string;
      uninstallscript?: string;
      versiondescription?: string;
      versionname?: string;
      versionnumber?: string;
      wait?: number;
    },
    onProgress?: (progress: PackageVersionCreateReportProgress) => void,
  ): Promise<PackageVersionCreateRequestResult> {
    const connection = this.requireDevhubConnection(options?.apiVersion);
    const waitDuration = Duration.minutes(options?.wait ?? 0);
    const frequency = options?.wait && options?.skipvalidation ? Duration.seconds(5) : Duration.seconds(30);

    const removeProgress = this.onLifecycle<PackageVersionCreateReportProgress>(
      PackageVersionEvents.create.progress,
      data => onProgress?.(data),
    );
    const removePreserve = this.onLifecycle<{location: string; message: string}>(
      PackageVersionEvents.create['preserve-files'],
      data => this.logger?.debug(`Preserved files at: ${data.location}`),
    );

    try {
      env.setBoolean('SF_APPLY_REPLACEMENTS_ON_CONVERT', true);
      const project = await SfProject.resolve(options?.projectPath);

      const result = await PackageVersion.create(
        {
          asyncvalidation: options?.asyncvalidation,
          branch: options?.branch,
          codecoverage: options?.codecoverage,
          connection,
          definitionfile: options?.definitionfile,
          installationkey: options?.installationkey,
          installationkeybypass: options?.installationkeybypass,
          packageId,
          path: options?.path,
          postinstallscript: options?.postinstallscript,
          postinstallurl: options?.postinstallurl,
          project,
          releasenotesurl: options?.releasenotesurl,
          skipancestorcheck: options?.skipancestorcheck,
          skipvalidation: options?.skipvalidation,
          tag: options?.tag,
          uninstallscript: options?.uninstallscript,
          versiondescription: options?.versiondescription,
          versionname: options?.versionname,
          versionnumber: options?.versionnumber,
        },
        {frequency, timeout: waitDuration},
      );

      if (result.Status === Package2VersionStatus.error) {
        const errors = result.Error?.map((e: string, i: number) => `(${i + 1}) ${e}`).join('; ') ?? 'Unknown error';
        throw new Error(`Package version creation failed: ${errors}`);
      }

      if (result.Status === Package2VersionStatus.success) {
        this.logger?.info(`Package version created: ${result.SubscriberPackageVersionId} `
          + `(${INSTALL_URL_BASE.href}${result.SubscriberPackageVersionId})`);
      }

      return result;
    } finally {
      removeProgress();
      removePreserve();
    }
  }

  // -----------------------------------------------------------------------
  // Package Version — Create
  // -----------------------------------------------------------------------

  /**
   * Delete (or undelete) a package.
   *
   * @param packageId - Package ID (0Ho) or alias — required
   * @param options   - Set `undelete: true` to restore a soft-deleted package
   */
  public async deletePackage(
    packageId: string,
    options?: {projectPath?: string; undelete?: boolean},
  ): Promise<PackageSaveResult> {
    const connection = this.requireDevhubConnection();
    const project = await this.maybeResolveProject(options?.projectPath);

    const pkg = new Package({connection, packageAliasOrId: packageId, project});
    return options?.undelete ? pkg.undelete() : pkg.delete();
  }

  // -----------------------------------------------------------------------
  // Package — Install
  // -----------------------------------------------------------------------

  /**
   * Delete (or undelete) a package version.
   *
   * @param idOrAlias - Package version ID (04t/05i) or alias — required
   * @param options   - Set `undelete: true` to restore a soft-deleted version
   */
  public async deletePackageVersion(
    idOrAlias: string,
    options?: {projectPath?: string; undelete?: boolean},
  ): Promise<PackageSaveResult> {
    const connection = this.requireDevhubConnection();
    const project = await this.maybeResolveProject(options?.projectPath);

    const pv = new PackageVersion({connection, idOrAlias, project});
    return options?.undelete ? pv.undelete() : pv.delete();
  }

  // -----------------------------------------------------------------------
  // Package — Uninstall
  // -----------------------------------------------------------------------

  /**
   * Fetch a Package2Version record by its subscriber ID (04t).
   *
   * Uses a direct tooling SOQL query — the SDK doesn't expose a lookup-by-04t method.
   */
  public async getPackageVersionBySubscriberId(subscriberPackageVersionId: string): Promise<Package2Version> {
    const query = soql`
      SELECT ${PackageService.PACKAGE2_VERSION_FIELDS.join(', ')}
      FROM Package2Version
      WHERE SubscriberPackageVersionId = '${subscriberPackageVersionId}'
    `.trim();

    try {
      const records = await this.toolingQuery<Package2Version>(this.requireTargetOrgConnection(), query);
      return records[0];
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger?.error(`Unable to fetch package version for subscriber id: ${subscriberPackageVersionId}. Error: ${message}`);
      throw error;
    }
  }

  // -----------------------------------------------------------------------
  // Package Version — Update
  // -----------------------------------------------------------------------

  /**
   * Check the status of a package version create request.
   *
   * @param requestId - The package version create request ID (08c) — required
   */
  public async getVersionCreateStatus(requestId: string): Promise<PackageVersionCreateRequestResult> {
    const connection = this.requireDevhubConnection();
    return PackageVersion.getCreateStatus(requestId, connection);
  }

  // -----------------------------------------------------------------------
  // Package Version — Delete
  // -----------------------------------------------------------------------

  /**
   * Install a package version into the target org.
   *
   * @param packageVersionId - Subscriber package version ID (04t) or alias — required
   * @param options          - Install options
   * @param onProgress       - Called with install status updates during polling
   */
  public async installPackage(
    packageVersionId: string,
    options?: {
      apexCompile?: 'all' | 'package';
      installationKey?: string;
      publishWait?: number;
      securityType?: 'AdminsOnly' | 'AllUsers';
      upgradeType?: 'Delete' | 'DeprecateOnly' | 'Mixed';
      wait?: number;
    },
    onProgress?: (status: PackagingSObjects.PackageInstallRequest) => void,
  ): Promise<PackagingSObjects.PackageInstallRequest> {
    const connection = this.requireTargetOrgConnection();

    const subscriberPackageVersion = new SubscriberPackageVersion({
      aliasOrId: packageVersionId,
      connection,
      password: options?.installationKey,
    });

    // --- Publish wait ---
    const removeSubscriberStatus = options?.publishWait
      ? this.onLifecycle<PackagingSObjects.InstallValidationStatus>(
        PackageEvents.install['subscriber-status'],
        status => this.logger?.debug(`Publish status: ${status}`),
      )
      : undefined;

    if (options?.publishWait) {
      await subscriberPackageVersion.waitForPublish({
        installationKey: options.installationKey,
        publishFrequency: Duration.seconds(10),
        publishTimeout: Duration.minutes(options.publishWait),
      });
    }

    removeSubscriberStatus?.();

    // --- Build install request ---
    const request: PackageInstallCreateRequest = {
      ApexCompileType: options?.apexCompile ?? 'all',
      Password: options?.installationKey,
      SecurityType: SECURITY_TYPE_MAP[options?.securityType ?? 'AdminsOnly'],
      SubscriberPackageVersionKey: await subscriberPackageVersion.getId(),
      UpgradeType: UPGRADE_TYPE_MAP[options?.upgradeType ?? 'Mixed'],
    };

    // --- Install with optional polling ---
    const removeWarning = this.onLifecycle<string>(
      PackageEvents.install.warning,
      msg => this.logger?.warn(msg),
    );
    const removeStatus = onProgress
      ? this.onLifecycle<PackagingSObjects.PackageInstallRequest>(
        PackageEvents.install.status,
        req => onProgress(req),
      )
      : undefined;

    try {
      let installOptions: PackageInstallOptions | undefined;
      if (options?.wait) {
        installOptions = {
          pollingFrequency: Duration.seconds(2),
          pollingTimeout: Duration.minutes(options.wait),
        };
      }

      return await subscriberPackageVersion.install(request, installOptions);
    } finally {
      removeWarning();
      removeStatus?.();
    }
  }

  // -----------------------------------------------------------------------
  // Package Version — Report
  // -----------------------------------------------------------------------

  /**
   * Check whether a specific subscriber package version (04t ID) is already installed.
   *
   * Uses the cache when available, otherwise queries the org directly.
   */
  public async isSubscriberVersionInstalled(subscriberPackageVersionId: string): Promise<boolean> {
    if (this.installedCache) {
      return this.installedCache.some(pkg => pkg.SubscriberPackageVersionId === subscriberPackageVersionId);
    }

    try {
      const query = soql`
        SELECT Id
        FROM InstalledSubscriberPackage
        WHERE SubscriberPackageVersion.Id = '${subscriberPackageVersionId}'
        LIMIT 1
      `.trim();

      const records = await this.toolingQuery<{Id: string}>(this.requireTargetOrgConnection(), query);
      return records.length > 0;
    } catch {
      this.logger?.warn(`Unable to check if subscriber version ${subscriberPackageVersionId} is installed`);
      return false;
    }
  }

  // -----------------------------------------------------------------------
  // Package Version — Create Status
  // -----------------------------------------------------------------------

  /**
   * List all packages installed in the target org.
   *
   * Wraps `SubscriberPackageVersion.installedList()` from the SDK.
   * Uses the cache when populated via {@link preloadInstalledPackages}.
   */
  public async listInstalledPackages(): Promise<InstalledPackages[]> {
    if (this.installedCache) {
      return this.installedCache;
    }

    const connection = this.requireTargetOrgConnection();
    return SubscriberPackageVersion.installedList(connection);
  }

  // -----------------------------------------------------------------------
  // Listing — DevHub
  // -----------------------------------------------------------------------

  /**
   * List all 2GP packages in the DevHub.
   *
   * Wraps `Package.list()` from the SDK.
   */
  public async listPackages(): Promise<PackagingSObjects.Package2[]> {
    const connection = this.requireDevhubConnection();
    return Package.list(connection);
  }

  /**
   * List package versions in the DevHub, with optional filters.
   *
   * Wraps `Package.listVersions()` from the SDK.
   * See {@link PackageVersionListOptions} for filter/sort options.
   *
   * @param options - Filter and display options
   */
  public async listPackageVersions(options?: PackageVersionListOptions & {projectPath?: string}): Promise<PackageVersionListResult[]> {
    const connection = this.requireDevhubConnection();

    // ponytail: project is optional in the SDK — resolve when available, skip when not
    let project: SfProject | undefined;
    try {
      project = await SfProject.resolve(options?.projectPath);
    } catch {
      // not in a project directory — list without project context
    }

    return Package.listVersions(connection, project, options);
  }

  // -----------------------------------------------------------------------
  // Listing — Target Org
  // -----------------------------------------------------------------------

  /**
   * Preload all installed packages into an in-memory cache.
   * Subsequent calls to {@link listInstalledPackages} and {@link isSubscriberVersionInstalled}
   * use the cache instead of querying the org.
   */
  public async preloadInstalledPackages(): Promise<void> {
    const connection = this.requireTargetOrgConnection();
    this.installedCache = await SubscriberPackageVersion.installedList(connection);
    this.logger?.debug(`Preloaded ${this.installedCache.length} installed package(s) into cache`);
  }

  /**
   * Promote a package version to released state.
   *
   * Accepts a subscriber package version ID (04t), package version ID (05i), or alias.
   * Idempotent — returns immediately if already released.
   * On transient failure, verifies server-side state before propagating.
   */
  public async promoteVersion(idOrAlias: string): Promise<void> {
    const connection = this.requireDevhubConnection();
    const pv = new PackageVersion({connection, idOrAlias});

    const versionData = await pv.getData();
    if (versionData.IsReleased) {
      this.logger?.debug(`Package version ${idOrAlias} is already released — skipping promote`);
      return;
    }

    try {
      const result = await pv.promote();
      if (!result.success) {
        throw new Error(`Failed to promote package version ${idOrAlias}: ${JSON.stringify(result.errors)}`);
      }
    } catch (error) {
      this.logger?.debug(`Promote call failed for ${idOrAlias}, verifying server-side state...`);
      const refreshed = await pv.getData(true);
      if (refreshed.IsReleased) {
        this.logger?.info(`Package version ${idOrAlias} was promoted server-side despite client error`);
        return;
      }

      throw error;
    }
  }

  // -----------------------------------------------------------------------
  // Version — Lookup
  // -----------------------------------------------------------------------

  /**
   * Get a detailed report for a package version.
   *
   * @param idOrAlias - Package version ID (04t/05i) or alias — required
   * @param options   - Set `verbose: true` for extended details (slower)
   */
  public async reportPackageVersion(
    idOrAlias: string,
    options?: {projectPath?: string; verbose?: boolean},
  ): Promise<PackageVersionReportResult> {
    const connection = this.requireDevhubConnection();
    const project = await this.maybeResolveProject(options?.projectPath);

    const pv = new PackageVersion({connection, idOrAlias, project});
    return pv.report(options?.verbose);
  }

  // -----------------------------------------------------------------------
  // Version — Promote
  // -----------------------------------------------------------------------

  /** Set the logger for this instance. Chainable. */
  public setLogger(logger: Logger): this {
    this.logger = logger;
    return this;
  }

  // -----------------------------------------------------------------------
  // Cache
  // -----------------------------------------------------------------------

  /**
   * Uninstall a package from the target org.
   *
   * @param packageVersionId - Subscriber package version ID (04t) or alias — required
   * @param options          - Uninstall options
   * @param onProgress       - Called with uninstall status updates during polling
   */
  public async uninstallPackage(
    packageVersionId: string,
    options?: {
      wait?: number;
    },
    onProgress?: (status: PackagingSObjects.SubscriberPackageVersionUninstallRequest) => void,
  ): Promise<PackagingSObjects.SubscriberPackageVersionUninstallRequest> {
    const connection = this.requireTargetOrgConnection();

    const subscriberPackageVersion = new SubscriberPackageVersion({
      aliasOrId: packageVersionId,
      connection,
      password: undefined,
    });

    const removeUninstallListener = onProgress
      ? this.onLifecycle<PackagingSObjects.SubscriberPackageVersionUninstallRequest>(
        PackageEvents.uninstall,
        data => onProgress(data),
      )
      : undefined;

    try {
      const result = await subscriberPackageVersion.uninstall(
        Duration.seconds(30),
        Duration.minutes(options?.wait ?? 0),
      );

      if (result.Status === 'Error') {
        throw new Error(`Package uninstall failed for ${packageVersionId}: ${result.Id}`);
      }

      if (result.Status === 'Success') {
        this.logger?.info(`Package ${result.SubscriberPackageVersionId} uninstalled successfully`);
      }

      return result;
    } finally {
      removeUninstallListener?.();
    }
  }

  /**
   * Update a package's metadata (name, description, error notification, etc.).
   *
   * @param packageId - Package ID (0Ho) or alias — required
   * @param options   - Fields to update (at least one required)
   */
  public async updatePackage(
    packageId: string,
    options: {
      appAnalyticsEnabled?: boolean;
      description?: string;
      errorNotificationUsername?: string;
      name?: string;
      projectPath?: string;
      recommendedVersionId?: string;
      skipAncestorCheck?: boolean;
    },
  ): Promise<PackageSaveResult> {
    const connection = this.requireDevhubConnection();
    const project = await this.maybeResolveProject(options.projectPath);

    const pkg = new Package({connection, packageAliasOrId: packageId, project});
    return pkg.update(
      {
        AppAnalyticsEnabled: options.appAnalyticsEnabled,
        Description: options.description,
        Id: pkg.getId(),
        Name: options.name,
        PackageErrorUsername: options.errorNotificationUsername,
        RecommendedVersionId: options.recommendedVersionId,
      },
      options.skipAncestorCheck,
    );
  }

  // -----------------------------------------------------------------------
  // Configuration
  // -----------------------------------------------------------------------

  /**
   * Update a package version's metadata.
   *
   * @param idOrAlias - Package version ID (04t/05i) or alias — required
   * @param options   - Fields to update
   */
  public async updatePackageVersion(
    idOrAlias: string,
    options: {
      branch?: string;
      installKey?: string;
      projectPath?: string;
      tag?: string;
      versionDescription?: string;
      versionName?: string;
    },
  ): Promise<PackageSaveResult> {
    const connection = this.requireDevhubConnection();
    const project = await this.maybeResolveProject(options.projectPath);

    const pv = new PackageVersion({connection, idOrAlias, project});
    return pv.update({
      Branch: options.branch,
      InstallKey: options.installKey,
      Tag: options.tag,
      VersionDescription: options.versionDescription,
      VersionName: options.versionName,
    });
  }

  // -----------------------------------------------------------------------
  // Private helpers
  // -----------------------------------------------------------------------

  /** Resolve SfProject when available, return undefined when not in a project directory. */
  private async maybeResolveProject(path?: string): Promise<SfProject | undefined> {
    try {
      return await SfProject.resolve(path);
    } catch {
      return undefined;
    }
  }

  /**
   * Register a Lifecycle event listener and return a removal function.
   */
  private onLifecycle<T>(event: string, handler: (data: T) => void): () => void {
    const wrapped = async (data: T): Promise<void> => {
      handler(data);
    };

    Lifecycle.getInstance().on(event, wrapped);
    return () => Lifecycle.getInstance().removeAllListeners(event);
  }

  private requireDevhubConnection(apiVersion?: string): Connection {
    if (!this.devhub) {
      throw new Error('Devhub must be connected');
    }

    return this.devhub.getConnection(apiVersion);
  }

  private requireTargetOrgConnection(): Connection {
    if (!this.targetOrg) {
      throw new Error('Target org must be connected');
    }

    return this.targetOrg.getConnection();
  }

  private async toolingQuery<T>(connection: Connection, query: string): Promise<T[]> {
    return (await connection.tooling.query(query)).records as T[];
  }
}
