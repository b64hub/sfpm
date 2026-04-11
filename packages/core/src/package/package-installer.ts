import {Org} from '@salesforce/core';
import EventEmitter from 'node:events';

import {ArtifactService, InstallTarget} from '../artifacts/artifact-service.js';
import ProjectConfig from '../project/project-config.js';
import {Logger} from '../types/logger.js';
import {InstallationMode, InstallationSource, PackageType} from '../types/package.js';
import {Installer, InstallerRegistry} from './installers/installer-registry.js';
import {ManagedPackageRef} from './installers/types.js';
import {PackageService} from './package-service.js';
import SfpmPackage, {PackageFactory, SfpmUnlockedPackage} from './sfpm-package.js';
// Import installers to trigger registration
import './installers/unlocked-package-installer.js';
import './installers/source-package-installer.js';
import './installers/managed-package-installer.js';

export interface InstallOptions {
  /** Force reinstall even if already installed with matching version/hash */
  force?: boolean;
  /** Force refresh from npm registry (bypass TTL cache) */
  forceRefresh?: boolean;
  installationKey?: string;
  /** Only use local artifacts, don't check npm registry */
  localOnly?: boolean;
  /**
   * Set specific installation mode (mainly for unlocked packages, overrides auto-detection).
   */
  mode?: InstallationMode;
  /**
   * Where to install from: 'local' (project source) or 'artifact'.
   */
  source?: InstallationSource;
  targetOrg: string;
  /**
   * When true, creates an `Sfpm_Artifact_History__c` record after each artifact upsert.
   * Read from `sfpmConfig.artifacts?.trackHistory` and passed through by the CLI/Actions layer.
   */
  trackHistory?: boolean;
}

export interface InstallResult {
  /** Salesforce deploy ID or PackageInstallRequest ID (when available) */
  deployId?: string;
  installed: boolean;
  packageName: string;
  skipped: boolean;
  skipReason?: string;
  version: string;
}

export interface InstallTask {
  exec(): Promise<void>;
}

/**
 * Orchestrator for package installations
 */
export default class PackageInstaller extends EventEmitter {
  private logger: Logger | undefined;
  private options: InstallOptions;
  private org?: Org;
  private projectConfig: ProjectConfig;

  constructor(
    projectConfig: ProjectConfig,
    options: InstallOptions,
    logger?: Logger,
    org?: Org,
  ) {
    super();
    this.options = options;
    this.logger = logger;
    this.projectConfig = projectConfig;
    this.org = org;
  }

  /**
   * Install a single package by name.
   *
   * This method:
   * 1. Resolves the best artifact version (local or from npm)
   * 2. Checks if installation is needed based on org status
   * 3. Installs using the appropriate installer for the package type
   *
   * @param packageName - Name of the package to install
   * @returns InstallResult with details of what happened
   */
  public async installPackage(packageName: string): Promise<InstallResult> {
    const factory = new PackageFactory(this.projectConfig);

    // Managed packages: skip artifact resolution, go straight to version install
    if (factory.isManagedPackage(packageName)) {
      const managedRef = factory.createManagedRef(packageName);
      if (!managedRef) {
        throw new Error(`Managed package ${packageName} could not be resolved from project aliases`);
      }

      return this.installManagedPackage(managedRef);
    }

    // Create local package from project config
    const sfpmPackage = factory.createFromName(packageName);

    if (!sfpmPackage) {
      throw new Error(`Package ${packageName} not found in project configuration`);
    }

    try {
      return this.installSfpmPackage(sfpmPackage);
    } catch (error) {
      this.logger?.error(`Failed to install ${packageName}: ${error instanceof Error ? error.message : String(error)}`);
      throw error;
    }
  }

  private emitComplete(sfpmPackage: SfpmPackage, installTarget: InstallTarget): void {
    this.emit('install:complete', {
      packageName: sfpmPackage.packageName,
      packageType: sfpmPackage.type as PackageType,
      source: installTarget.resolved.source,
      success: true,
      targetOrg: this.options.targetOrg,
      timestamp: new Date(),
      versionNumber: sfpmPackage.version,
    });
  }

  private emitError(sfpmPackage: SfpmPackage, error: Error): void {
    this.emit('install:error', {
      error: error instanceof Error ? error.message : String(error),
      packageName: sfpmPackage.packageName,
      packageType: sfpmPackage.type as PackageType,
      targetOrg: this.options.targetOrg,
      timestamp: new Date(),
      versionNumber: sfpmPackage.version,
    });
  }

  private emitManagedComplete(packageName: string, packageVersionId: string, success: boolean): void {
    this.emit('install:complete', {
      packageName,
      packageType: PackageType.Managed,
      packageVersionId,
      source: 'managed',
      success,
      targetOrg: this.options.targetOrg,
      timestamp: new Date(),
    });
  }

  private emitManagedError(packageName: string, packageVersionId: string): void {
    this.emit('install:error', {
      packageName,
      packageType: PackageType.Managed,
      packageVersionId,
      source: 'managed',
      success: false,
      targetOrg: this.options.targetOrg,
      timestamp: new Date(),
    });
  }

  private emitManagedSkip(packageName: string, packageVersionId: string, reason: string): void {
    this.emit('install:skip', {
      packageName,
      packageType: PackageType.Managed,
      packageVersionId,
      reason,
      source: 'managed',
      targetOrg: this.options.targetOrg,
      timestamp: new Date(),
    });
  }

  private emitManagedStart(packageName: string, packageVersionId: string): void {
    this.emit('install:start', {
      installReason: 'managed dependency',
      packageName,
      packageType: PackageType.Managed,
      packageVersionId,
      source: 'managed',
      targetOrg: this.options.targetOrg,
      timestamp: new Date(),
    });
  }

  private emitSkip(sfpmPackage: SfpmPackage, reason: string): void {
    this.emit('install:skip', {
      packageName: sfpmPackage.packageName,
      packageType: sfpmPackage.type as PackageType,
      reason,
      targetOrg: this.options.targetOrg,
      timestamp: new Date(),
      versionNumber: sfpmPackage.version,
    });
  }

  private emitStart(sfpmPackage: SfpmPackage, installTarget: InstallTarget): void {
    this.emit('install:start', {
      installReason: installTarget.installReason,
      packageName: sfpmPackage.packageName,
      packageType: sfpmPackage.type as PackageType,
      source: installTarget.resolved.source,
      targetOrg: this.options.targetOrg,
      timestamp: new Date(),
      versionNumber: sfpmPackage.version,
    });
  }

  /**
   * Forward sub-events from a concrete installer (e.g. ManagedPackageInstaller)
   * through this PackageInstaller so they propagate to the orchestrator/renderer.
   * Injects `packageName` into each event payload since concrete installers may omit it.
   */
  private forwardInstallerEvents(installer: EventEmitter | Installer, packageName: string): void {
    // Guard: concrete installers extend EventEmitter, but the Installer interface
    // does not require it. Only forward when the installer actually emits events.
    if (typeof (installer as any).on !== 'function') return;

    const emitter = installer as EventEmitter;
    const events = [
      'connection:start',
      'connection:complete',
      'version-install:start',
      'version-install:progress',
      'version-install:complete',
      'deployment:start',
      'deployment:progress',
      'deployment:complete',
    ];

    for (const event of events) {
      emitter.on(event, (data: any) => {
        this.emit(event, {...data, packageName});
      });
    }
  }

  /**
   * Fast path for managed packages — no artifact resolution needed.
   * Uses the packageVersionId already known from packageAliases.
   * Checks if the version is already installed before attempting installation.
   */
  private async installManagedPackage(managedRef: ManagedPackageRef): Promise<InstallResult> {
    const {packageName} = managedRef;

    // Check if the managed package version is already installed (unless forced)
    if (!this.options.force) {
      if (!this.org) {
        this.org = await Org.create({aliasOrUsername: this.options.targetOrg});
      }

      try {
        const packageService = PackageService.getInstance()
        .setOrg(this.org);
        if (this.logger) packageService.setLogger(this.logger);
        const isInstalled = await packageService.isSubscriberVersionInstalled(managedRef.packageVersionId);
        if (isInstalled) {
          const reason = `Version ${managedRef.packageVersionId} already installed`;
          this.logger?.info(`Skipping managed package ${packageName}: ${reason}`);
          this.emitManagedSkip(packageName, managedRef.packageVersionId, reason);
          return {
            installed: false,
            packageName,
            skipped: true,
            skipReason: reason,
            version: managedRef.packageVersionId,
          };
        }
      } catch (error) {
        this.logger?.warn(`Unable to check if ${packageName} is installed, proceeding with install: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    this.emitManagedStart(packageName, managedRef.packageVersionId);

    try {
      const InstallerConstructor = InstallerRegistry.getInstaller(PackageType.Managed as any);
      if (!InstallerConstructor) {
        throw new Error('No installer registered for package type: managed');
      }

      const installer = new InstallerConstructor(this.options.targetOrg, managedRef, this.logger);

      // Forward sub-events (connection:*, version-install:*) from the managed
      // installer through this PackageInstaller so they reach the renderer.
      // Inject packageName into payloads since ManagedPackageInstaller omits it.
      this.forwardInstallerEvents(installer, packageName);

      await installer.connect(this.options.targetOrg);
      await installer.exec();

      this.emitManagedComplete(packageName, managedRef.packageVersionId, true);
      this.logger?.info(`Successfully installed managed package ${packageName}`);

      return {
        installed: true,
        packageName,
        skipped: false,
        version: managedRef.packageVersionId,
      };
    } catch (error) {
      this.emitManagedError(packageName, managedRef.packageVersionId);
      this.logger?.error(`Failed to install managed package ${packageName}: ${error instanceof Error ? error.message : String(error)}`);
      throw error;
    }
  }

  /**
   * Install a package by resolving the appropriate artifact and using the correct installer strategy.
   * @param sfpmPackage
   * @returns installResult
   */
  private async installSfpmPackage(sfpmPackage: SfpmPackage): Promise<InstallResult> {
    const packageName = sfpmPackage.name;

    if (!this.org) {
      this.org = await Org.create({aliasOrUsername: this.options.targetOrg});
    }

    const {npmName} = sfpmPackage;
    if (!npmName) {
      throw new Error(`Package "${packageName}" has no npm name. `
        + 'In workspace mode, this is set from the package.json "name" field. '
        + 'Run `sfpm init turbo` to migrate from sfdx-project.json.');
    }

    // Use singleton artifact service
    const artifactService = ArtifactService.getInstance()
    .setOrg(this.org)
    .setLogger(this.logger);

    const installTarget = await artifactService.resolveInstallTarget(
      sfpmPackage.projectDirectory,
      sfpmPackage.packageName,
      {
        forceRefresh: this.options.forceRefresh,
        localOnly: this.options.localOnly,
        npmName,
      },
    );

    this.updatePackageFromTarget(sfpmPackage, installTarget);

    if (!this.options.force && !installTarget.needsInstall) {
      this.logger?.info(`Skipping ${packageName}@${installTarget.resolved.version}: ${installTarget.installReason}`);
      this.emitSkip(sfpmPackage, installTarget.installReason);

      return {
        installed: false,
        packageName,
        skipped: true,
        skipReason: installTarget.installReason,
        version: installTarget.resolved.version,
      };
    }

    // Log install decision
    this.logger?.info(`Installing ${packageName}@${installTarget.resolved.version} `
      + `(reason: ${installTarget.installReason}, source: ${installTarget.resolved.source})`);
    this.emitStart(sfpmPackage, installTarget);

    try {
      const InstallerConstructor = InstallerRegistry.getInstaller(sfpmPackage.type as any);
      if (!InstallerConstructor) {
        throw new Error(`No installer registered for package type: ${sfpmPackage.type}`);
      }

      const installer = new InstallerConstructor(this.options.targetOrg, sfpmPackage, this.logger);

      // Forward sub-events (connection:*, deployment:*, version-install:*) from the
      // concrete installer through this PackageInstaller so they reach the renderer.
      this.forwardInstallerEvents(installer, packageName);

      await installer.connect(this.options.targetOrg);
      const execResult = await installer.exec();

      await artifactService.upsertArtifact(sfpmPackage);

      // Create history record when opt-in tracking is enabled
      if (this.options.trackHistory) {
        await artifactService.createHistoryRecord(sfpmPackage, {
          deployId: execResult.deployId,
        });
      }

      this.emitComplete(sfpmPackage, installTarget);
      this.logger?.info(`Successfully installed ${packageName}@${sfpmPackage.version}`);

      return {
        deployId: execResult.deployId,
        installed: true,
        packageName,
        skipped: false,
        version: installTarget.resolved.version,
      };
    } catch (error) {
      this.emitError(sfpmPackage, error as Error);
      this.logger?.error(`Failed to install ${packageName}: ${error instanceof Error ? error.message : String(error)}`);
      throw error;
    }
  }

  /**
   * Update the SfpmPackage instance with information from the resolved install target.
   */
  private updatePackageFromTarget(sfpmPackage: SfpmPackage, installTarget: InstallTarget): void {
    const {resolved} = installTarget;

    // Set version from resolved artifact
    sfpmPackage.version = resolved.version;
    sfpmPackage.sourceHash = resolved.versionEntry.sourceHash;

    // For unlocked packages, set the packageVersionId
    if (sfpmPackage instanceof SfpmUnlockedPackage && resolved.packageVersionId) {
      sfpmPackage.packageVersionId = resolved.packageVersionId;
    }
  }
}
