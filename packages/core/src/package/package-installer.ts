import {Org} from '@salesforce/core';
import EventEmitter from 'node:events';

import {ArtifactService, InstallTarget} from '../artifacts/artifact-service.js';
import ProjectConfig from '../project/project-config.js';
import {Logger} from '../types/logger.js';
import {InstallationMode, InstallationSource, PackageType} from '../types/package.js';
import {InstallerRegistry} from './installers/installer-registry.js';
import SfpmPackage, {PackageFactory, SfpmManagedPackage, SfpmUnlockedPackage} from './sfpm-package.js';
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
}

export interface InstallResult {
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
  private artifactService?: ArtifactService;
  private logger: Logger | undefined;
  private options: InstallOptions;
  private org?: Org;
  private projectConfig: ProjectConfig;

  constructor(
    projectConfig: ProjectConfig,
    options: InstallOptions,
    logger?: Logger,
    org?: Org,
    artifactService?: ArtifactService,
  ) {
    super();
    this.options = options;
    this.logger = logger;
    this.projectConfig = projectConfig;
    this.org = org;
    this.artifactService = artifactService;
  }

  /**
   * Install multiple packages and their dependencies.
   * @deprecated Use InstallOrchestrator.installAll() for multi-package installs.
   * This stub exists for backwards compatibility — the CLI drives the orchestrator directly.
   */
  public async install(): Promise<void> {
    // TODO: Implement dependency resolution and installation
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
    // Create base package from project config
    const sfpmPackage = new PackageFactory(this.projectConfig).createFromName(packageName);

    // Managed packages: skip artifact resolution, go straight to version install
    if (sfpmPackage instanceof SfpmManagedPackage) {
      return this.installManagedPackage(sfpmPackage);
    }

    // Ensure we have an org connection
    if (!this.org) {
      this.org = await Org.create({aliasOrUsername: this.options.targetOrg});
    }

    // Get npm scope from project config for scoped registry lookup
    const npmScope = this.projectConfig.getProjectDefinition()?.plugins?.sfpm?.npmScope;

    // Use shared artifact service if provided, otherwise create a new one
    const artifactService = this.artifactService ?? new ArtifactService(this.logger, this.org);

    // Resolve install target (combines artifact resolution + org status check)
    const installTarget = await artifactService.resolveInstallTarget(
      sfpmPackage.projectDirectory,
      sfpmPackage.packageName,
      {
        forceRefresh: this.options.forceRefresh,
        localOnly: this.options.localOnly,
        npmScope,
      },
    );

    // Update package with resolved artifact info
    this.updatePackageFromTarget(sfpmPackage, installTarget);

    // Check if we should skip installation (default: skip if already installed, unless force is set)
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
      // Get installer for package type
      const InstallerConstructor = InstallerRegistry.getInstaller(sfpmPackage.type as any);
      if (!InstallerConstructor) {
        throw new Error(`No installer registered for package type: ${sfpmPackage.type}`);
      }

      // Create and execute installer
      const installer = new InstallerConstructor(this.options.targetOrg, sfpmPackage, this.logger);
      await installer.connect(this.options.targetOrg);
      await installer.exec();

      // Update artifact record in org
      await artifactService.upsertArtifact(sfpmPackage);

      this.emitComplete(sfpmPackage, installTarget);
      this.logger?.info(`Successfully installed ${packageName}@${sfpmPackage.version}`);

      return {
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

  private emitComplete(sfpmPackage: SfpmPackage, installTarget: InstallTarget): void {
    this.emit('install:complete', {
      packageName: sfpmPackage.packageName,
      packageType: sfpmPackage.type as PackageType,
      packageVersion: sfpmPackage.version,
      source: installTarget.resolved.source,
      success: true,
      targetOrg: this.options.targetOrg,
      timestamp: new Date(),
    });
  }

  private emitError(sfpmPackage: SfpmPackage, error: Error): void {
    this.emit('install:error', {
      error: error instanceof Error ? error.message : String(error),
      packageName: sfpmPackage.packageName,
      packageType: sfpmPackage.type as PackageType,
      packageVersion: sfpmPackage.version,
      targetOrg: this.options.targetOrg,
      timestamp: new Date(),
    });
  }

  private emitSkip(sfpmPackage: SfpmPackage, reason: string): void {
    this.emit('install:skip', {
      packageName: sfpmPackage.packageName,
      packageType: sfpmPackage.type as PackageType,
      packageVersion: sfpmPackage.version,
      reason,
      targetOrg: this.options.targetOrg,
      timestamp: new Date(),
    });
  }

  private emitStart(sfpmPackage: SfpmPackage, installTarget: InstallTarget): void {
    this.emit('install:start', {
      installReason: installTarget.installReason,
      packageName: sfpmPackage.packageName,
      packageType: sfpmPackage.type as PackageType,
      packageVersion: sfpmPackage.version,
      source: installTarget.resolved.source,
      targetOrg: this.options.targetOrg,
      timestamp: new Date(),
    });
  }

  /**
   * Fast path for managed packages — no artifact resolution needed.
   * Uses the packageVersionId already known from packageAliases.
   */
  private async installManagedPackage(sfpmPackage: SfpmManagedPackage): Promise<InstallResult> {
    const {packageName} = sfpmPackage;

    this.emit('install:start', {
      installReason: 'managed dependency',
      packageName,
      packageType: PackageType.Managed,
      packageVersion: sfpmPackage.packageVersionId,
      source: 'managed',
      targetOrg: this.options.targetOrg,
      timestamp: new Date(),
    });

    try {
      const InstallerConstructor = InstallerRegistry.getInstaller(PackageType.Managed as any);
      if (!InstallerConstructor) {
        throw new Error('No installer registered for package type: managed');
      }

      const installer = new InstallerConstructor(this.options.targetOrg, sfpmPackage, this.logger);
      await installer.connect(this.options.targetOrg);
      await installer.exec();

      this.emit('install:complete', {
        packageName,
        packageType: PackageType.Managed,
        packageVersion: sfpmPackage.packageVersionId,
        source: 'managed',
        success: true,
        targetOrg: this.options.targetOrg,
        timestamp: new Date(),
      });

      this.logger?.info(`Successfully installed managed package ${packageName}`);

      return {
        installed: true,
        packageName,
        skipped: false,
        version: sfpmPackage.packageVersionId,
      };
    } catch (error) {
      this.emitError(sfpmPackage, error as Error);
      this.logger?.error(`Failed to install managed package ${packageName}: ${error instanceof Error ? error.message : String(error)}`);
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
