import { Org } from '@salesforce/core';
import fs from 'fs-extra';
import { execSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';

import type { ProjectDefinitionProvider } from '../project/providers/project-definition-provider.js';

import { ArtifactService, InstallTarget } from '../artifacts/artifact-service.js';
import { InstallEventBus, InstallEventSink } from '../events/install-event-bus.js';
import { LifecycleEngine } from '../lifecycle/lifecycle-engine.js';
import { ArtifactResolutionOptions } from '../types/artifact.js';
import { HookContext, HookTiming } from '../types/lifecycle.js';
import { Logger } from '../types/logger.js';
import {
  InstallationMode, InstallationSource, PackageType, type TestLevel,
} from '../types/package.js';
import { resolvePackageWorkspacePath } from '../utils/workspace-path.js';
import { installerFactory, InstallTaskContext, InstallTaskRegistration } from './installers/installer-registry.js';
import { ManagedPackageRef } from './installers/types.js';
import { PackageService } from './package-service.js';
import SfpmPackage, {
  isOrgAliasable, PackageFactory, SfpmSourcePackage, SfpmUnlockedPackage,
} from './sfpm-package.js';
// Import installers to trigger registration
import './installers/unlocked-package-installer.js';
import './installers/source-package-installer.js';
import './installers/managed-package-installer.js';
import sfpmPackage from './sfpm-package.js';

export interface InstallOptions {
  artifactResolution?: Omit<ArtifactResolutionOptions, 'version'>;

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
  updateArtifact?: boolean;
  versionInstall?: { installationKeys?: { [packageName: string]: string } };
}

export interface InstallResult {
  /** Salesforce deploy ID or PackageInstallRequest ID (when available) */
  installId?: string;
  success: boolean;
  packageName: string;
  skipped: boolean;
  skipReason?: string;
  version: string;
}

/**
 * Orchestrator for package installations
 */
export default class PackageInstaller {
  private bus?: InstallEventBus;
  private logger: Logger | undefined;
  private options: InstallOptions;
  private targetOrg!: Org;
  private provider: ProjectDefinitionProvider;

  private tasks: InstallTaskRegistration[] = [];


  constructor(
    provider: ProjectDefinitionProvider,
    options: InstallOptions,
    logger?: Logger,
    bus?: InstallEventBus,
  ) {
    this.options = options;
    this.logger = logger;
    this.provider = provider;
    this.bus = bus;
  }

  public async connect(usernameOrOrg: string | Org): Promise<void> {
    if (usernameOrOrg instanceof Org) {
      this.targetOrg = usernameOrOrg;
    } else {
      this.targetOrg = await Org.create({ aliasOrUsername: usernameOrOrg });
    }
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
  public async install(packageName: string): Promise<InstallResult> {
    const factory = new PackageFactory(this.provider);

    if (!this.targetOrg) {
      throw new Error('Target org not connected. Call connect() before installing packages.');
    }

    // Managed packages: skip artifact resolution, go straight to version install
    if (factory.isManagedPackage(packageName)) {
      const managedRef = factory.createManagedRef(packageName);
      if (!managedRef) {
        throw new Error(`Managed package ${packageName} could not be resolved from project aliases`);
      }

      return this.installManagedPackage(managedRef);
    }

    const sfpmPackage = factory.createFromName(packageName);

    if (!sfpmPackage) {
      throw new Error(`Package ${packageName} not found in project configuration`);
    }

    try {
      // Source-local deploy: skip artifact resolution entirely — deploy from project source
      if (this.options.source === InstallationSource.Local) {
        return await this.deploySource(sfpmPackage);
      }

      return await this.installArtifact(sfpmPackage);
    } catch (error) {
      this.logger?.error(`Failed to install ${packageName}: ${error instanceof Error ? error.message : String(error)}`);
      throw error;
    }
  }

  /**
   * Deploy metadata directly from project source without artifact resolution.
   * Used for `sfpm deploy` where the source is the local project directory.
   */
  public async deploySource(sfpmPackage: SfpmPackage): Promise<InstallResult> {
    const packageName = sfpmPackage.name;

    const sink = this.bus?.forPackage(packageName);

    // For source deploys, set workingDirectory to the project root
    // so getComponentSet() can resolve the metadata path.
    if (!sfpmPackage.workingDirectory) {
      sfpmPackage.workingDirectory = this.provider.projectDir;
    }

    // Handle org-aliased packages: resolve the correct source directory
    await this.resolveOrgAliasForDeploy(sfpmPackage);

    this.logger?.info(`Deploying ${packageName} from local source`);
    sink?.start({
      installReason: 'source deploy',
      packageType: sfpmPackage.type as PackageType,
      source: InstallationSource.Local,
      targetOrg: this.targetOrg.getUsername(),
      versionNumber: sfpmPackage.version,
    });

    await this.runInstaller(sfpmPackage);
  }



  /**
   * Fast path for managed packages — no artifact resolution needed.
   * Uses the packageVersionId already known from packageAliases.
   * Checks if the version is already installed before attempting installation.
   */
  public async installManagedPackage(managedRef: ManagedPackageRef): Promise<InstallResult> {
    const { packageName } = managedRef;

    const sink = this.bus?.forPackage(packageName);

    // Check if the managed package version is already installed (unless forced)
    if (!this.options.force) {
      const checkResult = await this.checkPackageInstalled(managedRef, sink);
      if (checkResult?.skipped) {
        return checkResult;
      }
    }

    sink?.start({
      installReason: 'managed dependency',
      packageType: PackageType.Managed,
      packageVersionId: managedRef.packageVersionId,
      source: 'managed',
      targetOrg: this.targetOrg.getUsername(),
    });

    try {
      const installer = installerFactory(this.provider.projectDir, managedRef, this.options, this.logger, sink);
      await installer.connect(this.targetOrg);
      const result = await installer.exec();

      sink?.complete({
        packageType: PackageType.Managed,
        packageVersionId: managedRef.packageVersionId,
        source: 'managed',
        success: true,
        targetOrg: this.targetOrg.getUsername(),
      });
      this.logger?.info(`Successfully installed managed package ${packageName}`);

      return {
        success: true,
        packageName,
        skipped: false,
        version: managedRef.packageVersionId,
      };
    } catch (error) {
      sink?.error({
        error: `Installation failed for ${managedRef.packageVersionId}`,
        packageType: PackageType.Managed,
        packageVersionId: managedRef.packageVersionId,
        targetOrg: this.targetOrg.getUsername(),
      });
      this.logger?.error(`Failed to install managed package ${packageName}: ${error instanceof Error ? error.message : String(error)}`);
      throw error;
    }
  }

  private async checkPackageInstalled(managedRef: ManagedPackageRef, sink?: InstallEventSink): Promise<InstallResult | undefined> {

    const packageService = PackageService.getInstance()
      .setOrg(this.targetOrg);

    if (this.logger) packageService.setLogger(this.logger);

    try {
      const isInstalled = await packageService.isSubscriberVersionInstalled(managedRef.packageVersionId);

      if (!isInstalled) {
        return undefined;
      }

      const reason = `Version ${managedRef.packageVersionId} already installed`;
      this.logger?.info(`Skipping managed package ${managedRef.packageName}: ${reason}`);

      sink?.skip({
        packageType: PackageType.Managed,
        reason,
        targetOrg: this.targetOrg.getUsername(),
      });

      return {
        success: true,
        packageName: managedRef.packageName,
        skipped: true,
        skipReason: reason,
        version: managedRef.packageVersionId,
      };

    } catch (error) {
      this.logger?.warn(`Unable to check if ${managedRef.packageName} is installed, proceeding with install: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Install an artifact and using the correct installer strategy.
   * @param sfpmPackage
   * @returns installResult
   */
  public async installArtifact(sfpmPackage: SfpmPackage): Promise<InstallResult> {

    const packageName = sfpmPackage.name;

    const sink = this.bus?.forPackage(packageName);

    if (!packageName) {
      throw new Error(`Package "${packageName}" has no npm name. `
        + 'In workspace mode, this is set from the package.json "name" field. '
        + 'Run `sfpm init turbo` to migrate from sfdx-project.json.');
    }

    // Use singleton artifact service
    const artifactService = ArtifactService.getInstance()
      .setOrg(this.targetOrg)
      .setLogger(this.logger);

    const installTarget = await this.resolveInstallTarget(artifactService, sfpmPackage);

    if (!this.options.force && !installTarget.needsInstall) {
      this.logger?.info(`Skipping ${packageName}@${installTarget.resolved.version}: ${installTarget.installReason}`);
      sink?.skip({
        packageType: sfpmPackage.type as PackageType,
        reason: installTarget.installReason,
        targetOrg: this.targetOrg.getUsername(),
      });

      return {
        success: false,
        packageName,
        skipped: true,
        skipReason: installTarget.installReason,
        version: installTarget.resolved.version,
      };
    }

    // Log install decision
    this.logger?.info(`Installing ${packageName}@${installTarget.resolved.version} `
      + `(reason: ${installTarget.installReason}, source: ${installTarget.resolved.source})`);

    return await this.runInstaller(sfpmPackage, installTarget, sink);
  }

  private async runInstaller(sfpmPackage: SfpmPackage, installTarget: InstallTarget, sink?: InstallEventSink): Promise<InstallResult> {
    sink?.start({
      installReason: installTarget.installReason,
      packageType: sfpmPackage.type as PackageType,
      source: installTarget.resolved.source,
      targetOrg: this.targetOrg.getUsername(),
      versionNumber: sfpmPackage.version,
    });

    // Run pre-install hooks with the resolved package path
    // (extracted artifact dir for source packages, project source for unlocked)
    await this.runHooks('pre', sfpmPackage);

    try {
      
      const installer = installerFactory(this.provider.projectDir, sfpmPackage, this.options, this.logger, sink);
      await installer.connect(this.targetOrg);


      await this.runTasks('pre', {sfpmPackage, workingDirectory: this.provider.projectDir, targetOrg: this.targetOrg}, sink);

      const result = await installer.run();

      sink?.complete({
        packageType: sfpmPackage.type as PackageType,
        source: installTarget.resolved.source,
        success: true,
        targetOrg: this.targetOrg.getUsername(),
        versionNumber: sfpmPackage.version,
      });
      this.logger?.info(`Successfully installed ${sfpmPackage.name}@${sfpmPackage.version}`);

      await this.runTasks('post', {sfpmPackage, installId: result.installId, workingDirectory: this.provider.projectDir, targetOrg: this.targetOrg}, sink);
      // Run post-install hooks
      await this.runHooks('post', sfpmPackage);

      return {
        installId: result.deployId,
        success: true,
        packageName: sfpmPackage.name,
        skipped: false,
        version: installTarget.resolved.version,
      };
    } catch (error) {
      sink?.error({
        error: error instanceof Error ? error.message : String(error),
        packageType: sfpmPackage.type as PackageType,
        targetOrg: this.targetOrg.getUsername(),
        versionNumber: sfpmPackage.version,
      });
      this.logger?.error(`Failed to install ${sfpmPackage.name}: ${error instanceof Error ? error.message : String(error)}`);
      throw error;
    }
  }

  /**
   * Run task registrations sequentially, emitting lifecycle events.
   */
  private async runTasks(
    phase: 'post' | 'pre',
    ctx: InstallTaskContext,
    sink?: InstallEventSink,
  ): Promise<void> {

    for (const registration of this.tasks) {
      const task = registration.factory(ctx);
      const taskName = task.name;

      // Check runtime precondition
      if (task.canRun && !task.canRun()) {
        sink?.taskSkip({
          reason: `Precondition not met for task '${taskName}'`,
          taskName,
          phase,
        });
        continue;
      }

      sink?.taskStart({
        taskName,
        phase,
      });

      try {
        // eslint-disable-next-line no-await-in-loop -- tasks run sequentially, stop on first failure
        await task.exec();
      } catch (error) {
        sink?.taskComplete({
          success: false,
          taskName,
          phase,
        });

        throw error;
      }

      sink?.taskComplete({
        success: true,
        taskName,
        phase,
      });
    }
  }


  private async resolveInstallTarget(artifactService: ArtifactService, sfpmPackage: SfpmPackage): Promise<InstallTarget> {
    // Derive package workspace path for artifact resolution
    const sourcePath = sfpmPackage.packageDefinition?.path;
    const packageWorkspacePath = resolvePackageWorkspacePath(this.provider.projectDir, sourcePath);

    const installTarget = await artifactService.resolveInstallTarget(
      packageWorkspacePath,
      sfpmPackage.name,
      this.options.artifactResolution,
    );

    this.updatePackageFromTarget(sfpmPackage, installTarget);
    return installTarget;
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

    const resolution = await sfpmPackage.resolveOrgAlias(this.targetOrg.getUsername(), this.logger);
    this.logger?.info(`Org alias resolved for ${sfpmPackage.name}: alias='${resolution.resolvedAlias}', matched=${resolution.matched}`);

    // Create a staging root where path.join(stagingRoot, packageDefinition.path)
    // contains the resolved org-specific metadata
    const packageDefinition = this.provider.getPackageDefinition(sfpmPackage.name);
    const stagingRoot = path.join(os.tmpdir(), 'sfpm-org-alias', sfpmPackage.name, resolution.resolvedAlias);
    const stagingPackagePath = path.join(stagingRoot, packageDefinition.path);

    await fs.remove(stagingPackagePath);
    await fs.ensureDir(stagingPackagePath);
    await fs.copy(resolution.effectivePath, stagingPackagePath, { overwrite: true });

    sfpmPackage.workingDirectory = stagingRoot;
  }


  private async runHooks(timing: HookTiming, sfpmPackage: SfpmPackage, sink?: InstallEventSink): Promise<void> {
    if (!LifecycleEngine.isInitialized()) return;

    const lifecycle = LifecycleEngine.getInstance();
    const hookContext: HookContext = {
      logger: this.logger,
      operation: 'install',
      projectDir: this.provider.projectDir,
      sfpmPackage,
      stage: lifecycle.stage,
      targetOrg: this.targetOrg.getUsername(),
      timing,
    };

    if (timing === 'pre') {
      await lifecycle.runInstallPre(hookContext, sink);
    } else {
      await lifecycle.runInstallPost(hookContext, sink);
    }
  }


  /**
   * Update the SfpmPackage instance with information from the resolved install target.
   */
  private updatePackageFromTarget(sfpmPackage: SfpmPackage, installTarget: InstallTarget): void {
    const { resolved } = installTarget;

    // Set version from resolved artifact
    sfpmPackage.version = resolved.version;

    // For unlocked packages, set the packageVersionId
    if (sfpmPackage instanceof SfpmUnlockedPackage && resolved.packageVersionId) {
      sfpmPackage.packageVersionId = resolved.packageVersionId;
    }

    // For source packages, extract the artifact tarball so the source deployer
    // can build a ComponentSet from the metadata files inside.
    if (sfpmPackage instanceof SfpmSourcePackage && resolved.artifactPath) {
      const extractDir = path.join(os.tmpdir(), 'sfpm-install', sfpmPackage.name, resolved.version);
      fs.ensureDirSync(extractDir);
      execSync(`tar -xzf "${resolved.artifactPath}" -C "${extractDir}"`, { timeout: 60_000 });

      // npm tarballs extract into a package/ subdirectory
      sfpmPackage.workingDirectory = path.join(extractDir, 'package');
    }
  }
}
