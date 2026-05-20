import {Org} from '@salesforce/core';
import fs from 'fs-extra';
import {execSync} from 'node:child_process';
import EventEmitter from 'node:events';
import os from 'node:os';
import path from 'node:path';

import type {ProjectDefinitionProvider} from '../project/providers/project-definition-provider.js';

import {ArtifactService, InstallTarget} from '../artifacts/artifact-service.js';
import {LifecycleEngine} from '../lifecycle/lifecycle-engine.js';
import {ArtifactResolutionOptions} from '../types/artifact.js';
import {HookContext, HookTiming} from '../types/lifecycle.js';
import {Logger} from '../types/logger.js';
import {
  InstallationMode, InstallationSource, PackageType, type TestLevel,
} from '../types/package.js';
import {Installer, InstallerRegistry} from './installers/installer-registry.js';
import {ManagedPackageRef} from './installers/types.js';
import {PackageService} from './package-service.js';
// Import installers to trigger registration
import './installers/unlocked-package-installer.js';
import './installers/source-package-installer.js';
import './installers/managed-package-installer.js';
import SfpmPackage, {
  isOrgAliasable, PackageFactory, SfpmSourcePackage, SfpmUnlockedPackage,
} from './sfpm-package.js';

export interface InstallOptions {
  artifact?: {
    resolution?: Omit<ArtifactResolutionOptions, 'version'>;
    /**
     * Whether to update artifact records in the target org after installation.
     * When true (default), upserts `Sfpm_Artifact__c` and creates an
     * `Sfpm_Artifact_History__c` record (gracefully skipped if the object
     * is not deployed to the org).
     *
     * @default true
     */
    update?: boolean;
  }

  deployment?: {
    /**
     * Salesforce test level for source deployments.
     */
    testLevel?: TestLevel;
  };
  /** Force reinstall even if already installed with matching version/hash */
  force?: boolean;
  /**
   * Set specific installation mode (mainly for unlocked packages, overrides auto-detection).
   */
  mode?: InstallationMode;
  /**
   * Where to install from: 'local' (project source) or 'artifact'.
   */
  source?: InstallationSource;

  targetOrg: string;

  versionInstall?: {installationKeys?: {[packageName: string]: string}};
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
  private provider: ProjectDefinitionProvider;

  constructor(
    provider: ProjectDefinitionProvider,
    options: InstallOptions,
    logger?: Logger,
    org?: Org,
  ) {
    super();
    this.options = options;
    this.logger = logger;
    this.provider = provider;
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
    const factory = new PackageFactory(this.provider);

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
      packageName: sfpmPackage.name,
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
      packageName: sfpmPackage.name,
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
      packageName: sfpmPackage.name,
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
      packageName: sfpmPackage.name,
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
   * Install directly from project source without artifact resolution.
   * Used for `sfpm deploy` where the source is the local project directory.
   */
  private async installFromSource(sfpmPackage: SfpmPackage): Promise<InstallResult> {
    const packageName = sfpmPackage.name;

    if (!this.org) {
      this.org = await Org.create({aliasOrUsername: this.options.targetOrg});
    }

    // For source deploys, set workingDirectory to the project root
    // so getComponentSet() can resolve the metadata path.
    if (!sfpmPackage.workingDirectory) {
      sfpmPackage.workingDirectory = this.provider.projectDir;
    }

    // Handle org-aliased packages: resolve the correct source directory
    await this.resolveOrgAliasForDeploy(sfpmPackage);

    this.logger?.info(`Deploying ${packageName} from local source`);
    this.emit('install:start', {
      installReason: 'source deploy',
      packageName: sfpmPackage.name,
      packageType: sfpmPackage.type as PackageType,
      source: InstallationSource.Local,
      targetOrg: this.options.targetOrg,
      timestamp: new Date(),
      versionNumber: sfpmPackage.version,
    });

    // Install managed dependencies before deploying the package itself
    await this.installManagedDependencies(sfpmPackage);

    // Run pre-install hooks with the local source path
    await this.runHooks('pre', sfpmPackage);

    try {
      const InstallerConstructor = InstallerRegistry.getInstaller(sfpmPackage.type as any);
      if (!InstallerConstructor) {
        throw new Error(`No installer registered for package type: ${sfpmPackage.type}`);
      }

      const installer = new InstallerConstructor(this.options.targetOrg, sfpmPackage, this.logger, {
        source: InstallationSource.Local,
        testLevel: this.options.deployment?.testLevel,
      });
      this.forwardInstallerEvents(installer, packageName);

      await installer.connect(this.options.targetOrg);
      const execResult = await installer.exec();

      this.emit('install:complete', {
        packageName: sfpmPackage.name,
        packageType: sfpmPackage.type as PackageType,
        source: InstallationSource.Local,
        success: true,
        targetOrg: this.options.targetOrg,
        timestamp: new Date(),
        versionNumber: sfpmPackage.version,
      });
      this.logger?.info(`Successfully deployed ${packageName}`);

      // Run post-install hooks
      await this.runHooks('post', sfpmPackage);

      return {
        deployId: execResult.deployId,
        installed: true,
        packageName,
        skipped: false,
        version: sfpmPackage.version ?? 'local',
      };
    } catch (error) {
      this.emitError(sfpmPackage, error as Error);
      this.logger?.error(`Failed to deploy ${packageName}: ${error instanceof Error ? error.message : String(error)}`);
      throw error;
    }
  }

  /**
   * Install managed dependencies (04t subscriber versions) for a package
   * before deploying the package itself.
   *
   * Reads `managedDependencies` from the package definition and delegates
   * each one to {@link installManagedPackage}, reusing its skip-check,
   * VersionInstaller, events, and error handling.
   */
  private async installManagedDependencies(sfpmPackage: SfpmPackage): Promise<void> {
    const managedDependencies = sfpmPackage.packageDefinition?.managedDependencies;
    if (!managedDependencies || Object.keys(managedDependencies).length === 0) return;

    const SUBSCRIBER_PKG_VERSION_ID_PREFIX = '04t';
    const deps = Object.entries(managedDependencies)
    .filter(([, versionId]) => versionId.startsWith(SUBSCRIBER_PKG_VERSION_ID_PREFIX))
    .map(([depName, versionId]) => new ManagedPackageRef(depName, versionId));

    if (deps.length === 0) return;

    this.logger?.info(`Installing ${deps.length} managed dependency(ies) for '${sfpmPackage.name}'`);

    for (const dep of deps) {
      // eslint-disable-next-line no-await-in-loop -- sequential to avoid concurrent Tooling API requests
      await this.installManagedPackage(dep);
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
    // Source-local deploy: skip artifact resolution entirely — deploy from project source
    if (this.options.source === InstallationSource.Local) {
      return this.installFromSource(sfpmPackage);
    }

    const packageName = sfpmPackage.name;

    if (!this.org) {
      this.org = await Org.create({aliasOrUsername: this.options.targetOrg});
    }

    if (!packageName) {
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
      packageName,
      this.options.artifact?.resolution,
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

    // Install managed dependencies before deploying the package itself
    await this.installManagedDependencies(sfpmPackage);

    // Run pre-install hooks with the resolved package path
    // (extracted artifact dir for source packages, project source for unlocked)
    await this.runHooks('pre', sfpmPackage);

    try {
      const InstallerConstructor = InstallerRegistry.getInstaller(sfpmPackage.type as any);
      if (!InstallerConstructor) {
        throw new Error(`No installer registered for package type: ${sfpmPackage.type}`);
      }

      const installer = new InstallerConstructor(this.options.targetOrg, sfpmPackage, this.logger, {
        source: this.options.source,
        testLevel: this.options.deployment?.testLevel,
      });

      // Forward sub-events (connection:*, deployment:*, version-install:*) from the
      // concrete installer through this PackageInstaller so they reach the renderer.
      this.forwardInstallerEvents(installer, packageName);

      await installer.connect(this.options.targetOrg);
      const execResult = await installer.exec();

      if (this.options.artifact?.update !== false) {
        await artifactService.upsertArtifact(sfpmPackage);
        await artifactService.createHistoryRecord(sfpmPackage, {
          deployId: execResult.deployId,
        });
      }

      this.emitComplete(sfpmPackage, installTarget);
      this.logger?.info(`Successfully installed ${packageName}@${sfpmPackage.version}`);

      // Run post-install hooks
      await this.runHooks('post', sfpmPackage);

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
   * For org-aliased packages, resolve the org alias on the package and
   * update its working directory so that `packageDirectory` (and by
   * extension `getComponentSet()`) points at the org-specific content.
   *
   * Creates a staging directory where `packageDefinition.path` resolves
   * to the org-specific content, preserving the path structure expected
   * by downstream consumers.
   */
  private async resolveOrgAliasForDeploy(sfpmPackage: SfpmPackage): Promise<void> {
    if (!isOrgAliasable(sfpmPackage) || !sfpmPackage.isOrgAliased) return;

    const resolution = await sfpmPackage.resolveOrgAlias(this.options.targetOrg, this.logger);
    this.logger?.info(`Org alias resolved for ${sfpmPackage.name}: alias='${resolution.resolvedAlias}', matched=${resolution.matched}`);

    // Create a staging root where path.join(stagingRoot, packageDefinition.path)
    // contains the resolved org-specific metadata
    const packageDefinition = this.provider.getPackageDefinition(sfpmPackage.name);
    const stagingRoot = path.join(os.tmpdir(), 'sfpm-org-alias', sfpmPackage.name, resolution.resolvedAlias);
    const stagingPackagePath = path.join(stagingRoot, packageDefinition.path);

    await fs.remove(stagingPackagePath);
    await fs.ensureDir(stagingPackagePath);
    await fs.copy(resolution.effectivePath, stagingPackagePath, {overwrite: true});

    sfpmPackage.workingDirectory = stagingRoot;
  }

  /**
   * Resolve the absolute path to a package's metadata directory.
   *
   * Resolution hierarchy for the root:
   * 1. `workingDirectory` — set when an artifact has been extracted to a temp dir
   * 2. `projectDir` — the project root from the provider
   *
   * The package definition's `path` (e.g. `src-access-management`) is always
   * appended so the result points to the actual metadata directory, not just
   * the project/artifact root.
   *
   * For org-aliased packages, uses the package's resolved org alias path
   * (set by a prior call to {@link SfpmPackage.resolveOrgAlias}).
   */
  private resolvePackageSourceDir(sfpmPackage: SfpmPackage): string {
    // If org alias was resolved, use the effective path directly
    if (isOrgAliasable(sfpmPackage) && sfpmPackage.orgAliasResolution) {
      return sfpmPackage.orgAliasResolution.effectivePath;
    }

    const root = sfpmPackage.workingDirectory ?? this.provider.projectDir;
    const packageDefinition = this.provider.getPackageDefinition(sfpmPackage.name);
    return path.join(root, packageDefinition.path);
  }

  private async runHooks(timing: HookTiming, sfpmPackage: SfpmPackage): Promise<void> {
    if (!LifecycleEngine.isInitialized()) return;

    const lifecycle = LifecycleEngine.getInstance();
    const hookContext: HookContext = {
      logger: this.logger,
      operation: 'install',
      projectDir: this.provider.projectDir,
      sfpmPackage,
      stage: lifecycle.stage,
      targetOrg: this.options.targetOrg,
      timing,
    };

    if (timing === 'pre') {
      await lifecycle.runInstallPre(hookContext);
    } else {
      await lifecycle.runInstallPost(hookContext);
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

    // For source packages, extract the artifact tarball so the source deployer
    // can build a ComponentSet from the metadata files inside.
    if (sfpmPackage instanceof SfpmSourcePackage && resolved.artifactPath) {
      const extractDir = path.join(os.tmpdir(), 'sfpm-install', sfpmPackage.name, resolved.version);
      fs.ensureDirSync(extractDir);
      execSync(`tar -xzf "${resolved.artifactPath}" -C "${extractDir}"`, {timeout: 60_000});

      // npm tarballs extract into a package/ subdirectory
      sfpmPackage.workingDirectory = path.join(extractDir, 'package');
    }
  }
}
