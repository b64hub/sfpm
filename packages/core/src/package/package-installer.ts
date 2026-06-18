import {Org} from '@salesforce/core';

import type {ProjectDefinitionProvider} from '../project/providers/project-definition-provider.js';

import {ArtifactResolution, ArtifactService} from '../artifacts/artifact-service.js';
import {InstallEventBus, InstallEventSink} from '../events/install-event-bus.js';
import {LifecycleEngine} from '../lifecycle/lifecycle-engine.js';
import {ArtifactResolutionOptions} from '../types/artifact.js';
import {HookContext, HookTiming} from '../types/lifecycle.js';
import {Logger} from '../types/logger.js';
import {
  InstallationMode, InstallationSource, PackageType, type TestLevel,
} from '../types/package.js';
import {resolvePackageWorkspacePath} from '../utils/workspace-path.js';
import {installerFactory, InstallTaskContext, InstallTaskRegistration} from './installers/installer-registry.js';
import UpdateArtifactTask from './installers/tasks/update-artifact.js';
import {ManagedPackageRef} from './installers/types.js';
import SfpmPackage, {
  isOrgAliasable, PackageFactory, SfpmUnlockedPackage,
} from './sfpm-package.js';
// Import installers to trigger registration
import './installers/unlocked-package-installer.js';
import './installers/source-package-installer.js';
import './installers/managed-package-installer.js';

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
  versionInstall?: {installationKeys?: {[packageName: string]: string}};
}

export interface InstallResult {
  /** Salesforce deploy ID or PackageInstallRequest ID (when available) */
  installId?: string;
  packageName: string;
  skipped: boolean;
  skipReason?: string;
  success: boolean;
  version: string;
}

/**
 * Options for {@link PackageInstaller.runInstaller}.
 */
interface RunInstallerOptions {
  /** Whether to check if already installed before running. */
  checkInstalled: boolean;
  /**
   * Override installer type lookup.
   * E.g., route unlocked packages through the source installer for `sfpm deploy`.
   */
  installAs?: PackageType;
}

/**
 * Orchestrator for package installations
 */
export default class PackageInstaller {
  private bus?: InstallEventBus;
  private logger: Logger | undefined;
  private options: InstallOptions;
  private provider: ProjectDefinitionProvider;
  private targetOrg!: Org;
  private tasks: InstallTaskRegistration[] = [];

  constructor(
    provider: ProjectDefinitionProvider,
    options: InstallOptions,
    logger?: Logger,
    targetOrg?: Org,
    bus?: InstallEventBus,
  ) {
    this.options = options;
    this.logger = logger;
    this.provider = provider;
    if (targetOrg) this.targetOrg = targetOrg;
    this.bus = bus;
  }

  public async connect(usernameOrOrg: Org | string): Promise<void> {
    if (usernameOrOrg instanceof Org) {
      this.targetOrg = usernameOrOrg;
    } else {
      this.targetOrg = await Org.create({aliasOrUsername: usernameOrOrg});
    }
  }

  /**
   * Deploy from build output (`artifacts/package/`).
   * Requires a prior `sfpm build` (or Turbo cache restore).
   *
   * Routes unlocked packages through the source installer via `installAs`,
   * and skips the install-check since deploys are always executed.
   */
  public async deploySource(sfpmPackage: SfpmPackage): Promise<InstallResult> {
    // Resolve build output from the package workspace
    const sourcePath = sfpmPackage.packageDefinition?.path;
    if (!sourcePath) {
      throw new Error(`No package definition path for ${sfpmPackage.name}`);
    }

    const packageWorkspacePath = resolvePackageWorkspacePath(this.provider.projectDir, sourcePath);
    const buildOutput = ArtifactService.getInstance().getBuildOutput(packageWorkspacePath);

    if (!buildOutput) {
      throw new Error(`No build found for ${sfpmPackage.name}. Run 'sfpm build' before deploying.`);
    }

    sfpmPackage.workingDirectory = buildOutput;

    // Handle org-aliased packages: resolve the correct source directory
    await this.resolveOrgAliasForDeploy(sfpmPackage);

    this.logger?.info(`Deploying ${sfpmPackage.name} from build output`);

    return this.runInstaller(sfpmPackage, {
      checkInstalled: false,
      installAs: sfpmPackage.type === PackageType.Unlocked ? PackageType.Source : undefined,
    });
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
   * Install from a resolved artifact using the correct installer strategy.
   *
   * Resolves the artifact (local or npm), updates the package with version
   * and source hash, then delegates to {@link runInstaller} which handles
   * the install-check and full lifecycle (hooks, tasks, install, tasks, hooks).
   */
  public async installArtifact(sfpmPackage: SfpmPackage): Promise<InstallResult> {
    const packageName = sfpmPackage.name;

    if (!packageName) {
      throw new Error(`Package "${packageName}" has no npm name. `
        + 'In workspace mode, this is set from the package.json "name" field. '
        + 'Run `sfpm init turbo` to migrate from sfdx-project.json.');
    }

    // Use singleton artifact service
    const artifactService = ArtifactService.getInstance()
    .setOrg(this.targetOrg)
    .setProjectDir(this.provider.projectDir)
    .setLogger(this.logger);

    await this.resolveArtifact(artifactService, sfpmPackage);

    // Log install decision
    this.logger?.info(`Installing ${packageName}@${sfpmPackage.version}`);

    // Register artifact update as a post-install task
    this.tasks.push({
      factory: ctx => new UpdateArtifactTask(ctx),
      phase: 'post',
    });

    return this.runInstaller(sfpmPackage, {
      checkInstalled: !this.options.force,
    });
  }

  /**
   * Fast path for managed packages — no artifact resolution needed.
   * Uses the packageVersionId already known from packageAliases.
   *
   * Managed packages have no hooks or tasks, so they use a separate
   * path from {@link runInstaller}. The install-check is handled via
   * the installer's {@link Installer.isInstalled} method.
   */
  public async installManagedPackage(managedRef: ManagedPackageRef): Promise<InstallResult> {
    const {packageName} = managedRef;
    const sink = this.bus?.forPackage(packageName);

    const installer = installerFactory(this.provider.projectDir, managedRef, this.options, this.logger, sink);
    await installer.connect(this.targetOrg);

    // Check if already installed (unless forced)
    if (!this.options.force) {
      const check = await installer.isInstalled();
      if (!check.needsInstall) {
        const reason = `Version ${managedRef.packageVersionId} already installed`;
        this.logger?.info(`Skipping managed package ${packageName}: ${reason}`);
        sink?.skip({
          packageType: PackageType.Managed,
          reason,
          targetOrg: this.targetOrg.getUsername()!,
        });

        return {
          packageName,
          skipped: true,
          skipReason: reason,
          success: true,
          version: managedRef.packageVersionId,
        };
      }
    }

    sink?.start({
      installReason: 'managed dependency',
      packageType: PackageType.Managed,
      packageVersionId: managedRef.packageVersionId,
      source: 'managed',
      targetOrg: this.targetOrg.getUsername()!,
    });

    try {
      const result = await installer.run();

      sink?.complete({
        packageType: PackageType.Managed,
        packageVersionId: managedRef.packageVersionId,
        source: 'managed',
        success: true,
        targetOrg: this.targetOrg.getUsername()!,
      });
      this.logger?.info(`Successfully installed managed package ${packageName}`);

      return {
        packageName,
        skipped: false,
        success: true,
        version: managedRef.packageVersionId,
      };
    } catch (error) {
      sink?.error({
        error: `Installation failed for ${managedRef.packageVersionId}`,
        packageType: PackageType.Managed,
        packageVersionId: managedRef.packageVersionId,
        targetOrg: this.targetOrg.getUsername()!,
      });
      this.logger?.error(`Failed to install managed package ${packageName}: ${error instanceof Error ? error.message : String(error)}`);
      throw error;
    }
  }

  /**
   * Hydrate the SfpmPackage with data from the resolved artifact.
   * Sets version, source hash, packageVersionId, and working directory.
   */
  private hydratePackageFromArtifact(sfpmPackage: SfpmPackage, resolution: ArtifactResolution): void {
    const {resolved} = resolution;

    // Set version from resolved artifact
    sfpmPackage.version = resolved.version;

    // Set source hash from artifact manifest for install-skip checking.
    // The installer's isInstalled() compares this against the org's artifact record.
    if (resolved.manifest.sourceHash) {
      sfpmPackage.source = {
        ...sfpmPackage.source,
        sourceHash: resolved.manifest.sourceHash,
      };
    }

    // For unlocked packages, set the packageVersionId
    if (sfpmPackage instanceof SfpmUnlockedPackage && resolved.packageVersionId) {
      sfpmPackage.packageVersionId = resolved.packageVersionId;
    }

    // Set working directory to the build output (artifacts/package/)
    // Content is already assembled — no extraction needed.
    sfpmPackage.workingDirectory = resolved.artifactPath;
  }

  private async resolveArtifact(artifactService: ArtifactService, sfpmPackage: SfpmPackage): Promise<void> {
    const sourcePath = sfpmPackage.packageDefinition?.path;
    if (!sourcePath) {
      throw new Error(`No package definition path for ${sfpmPackage.name}`);
    }

    const packageWorkspacePath = resolvePackageWorkspacePath(this.provider.projectDir, sourcePath);

    const resolution = await artifactService.resolveArtifact(
      packageWorkspacePath,
      sfpmPackage.name,
      this.options.artifactResolution,
    );

    this.hydratePackageFromArtifact(sfpmPackage, resolution);
  }

  /**
   * For org-aliased packages, resolve which org directory to deploy from.
   * The package's `packageDirectory` getter will use the resolved path.
   */
  private async resolveOrgAliasForDeploy(sfpmPackage: SfpmPackage): Promise<void> {
    if (!isOrgAliasable(sfpmPackage) || !sfpmPackage.isOrgAliased) return;

    const resolution = await sfpmPackage.resolveOrgAlias(this.targetOrg.getUsername()!, this.logger);
    this.logger?.info(`Org alias resolved for ${sfpmPackage.name}: alias='${resolution.resolvedAlias}', matched=${resolution.matched}`);
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
      targetOrg: this.targetOrg.getUsername()!,
      timing,
    };

    if (timing === 'pre') {
      await lifecycle.runInstallPre(hookContext, sink);
    } else {
      await lifecycle.runInstallPost(hookContext, sink);
    }
  }

  /**
   * Unified install flow for source and unlocked packages.
   *
   * Handles the full lifecycle:
   * 1. Create installer (routed by type or `installAs` override)
   * 2. Connect to target org
   * 3. Check if already installed (gated by `checkInstalled`)
   * 4. Run pre-install hooks and tasks
   * 5. Execute the installer
   * 6. Run post-install tasks and hooks
   *
   * Managed packages bypass this method — see {@link installManagedPackage}.
   */
  private async runInstaller(sfpmPackage: SfpmPackage, options: RunInstallerOptions): Promise<InstallResult> {
    const sink = this.bus?.forPackage(sfpmPackage.name);

    const installer = installerFactory(this.provider.projectDir, sfpmPackage, this.options, this.logger, sink, options.installAs);
    await installer.connect(this.targetOrg);

    // Check if already installed
    if (options.checkInstalled) {
      const check = await installer.isInstalled();
      if (!check.needsInstall) {
        this.logger?.info(`Skipping ${sfpmPackage.name}@${sfpmPackage.version}: ${check.installReason}`);
        sink?.skip({
          packageType: sfpmPackage.type as PackageType,
          reason: check.installReason,
          targetOrg: this.targetOrg.getUsername()!,
        });

        return {
          packageName: sfpmPackage.name,
          skipped: true,
          skipReason: check.installReason,
          success: true,
          version: sfpmPackage.version ?? '',
        };
      }
    }

    // Emit start event
    sink?.start({
      packageType: sfpmPackage.type as PackageType,
      targetOrg: this.targetOrg.getUsername()!,
      versionNumber: sfpmPackage.version,
    });

    try {
      await this.runHooks('pre', sfpmPackage, sink);
      await this.runTasks('pre', {sfpmPackage, targetOrg: this.targetOrg, workingDirectory: this.provider.projectDir});

      const result = await installer.run();

      sink?.complete({
        packageType: sfpmPackage.type as PackageType,
        success: true,
        targetOrg: this.targetOrg.getUsername()!,
        versionNumber: sfpmPackage.version,
      });
      this.logger?.info(`Successfully installed ${sfpmPackage.name}@${sfpmPackage.version}`);

      await this.runTasks('post', {
        installId: result.installId, sfpmPackage, targetOrg: this.targetOrg, workingDirectory: this.provider.projectDir,
      });

      await this.runHooks('post', sfpmPackage, sink);

      return {
        installId: result.installId,
        packageName: sfpmPackage.name,
        skipped: false,
        success: true,
        version: sfpmPackage.version ?? '',
      };
    } catch (error) {
      sink?.error({
        error: error instanceof Error ? error.message : String(error),
        packageType: sfpmPackage.type as PackageType,
        targetOrg: this.targetOrg.getUsername()!,
        versionNumber: sfpmPackage.version,
      });
      this.logger?.error(`Failed to install ${sfpmPackage.name}: ${error instanceof Error ? error.message : String(error)}`);
      throw error;
    }
  }

  /**
   * Run task registrations sequentially.
   */
  private async runTasks(
    phase: 'post' | 'pre',
    ctx: InstallTaskContext,
  ): Promise<void> {
    for (const registration of this.tasks) {
      const task = registration.factory(ctx);
      const taskName = task.name;

      // Check runtime precondition
      if (task.canRun && !task.canRun()) {
        this.logger?.debug(`Skipping task '${taskName}': precondition not met`);
        continue;
      }

      this.logger?.debug(`Running ${phase} task: ${taskName}`);

      // eslint-disable-next-line no-await-in-loop -- tasks run sequentially, stop on first failure
      await task.exec();
    }
  }
}
