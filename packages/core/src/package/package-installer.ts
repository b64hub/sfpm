import {Org} from '@salesforce/core';

import type {ProjectDefinitionProvider} from '../project/providers/project-definition-provider.js';

import {InstallEventBus, InstallEventSink} from '../events/install-event-bus.js';
import {extractErrorDetails} from '../events/orchestration-event-bus.js';
import LifecycleEngine from '../lifecycle/lifecycle-engine.js';
import {InstallationError} from '../types/errors.js';
import {HookContext, HookTiming} from '../types/lifecycle.js';
import Logger from '../types/logger.js';
import {InstallOptions, PackageType} from '../types/package.js';
import {installerFactory, InstallTaskContext, InstallTaskRegistration} from './installers/installer-registry.js';
import UpdateArtifactTask from './installers/tasks/update-artifact.js';
import {ManagedPackageRef} from './installers/types.js';
import SfpmPackage, {PackageFactory, SfpmUnlockedPackage} from './sfpm-package.js';
// Import installers to trigger registration
import './installers/unlocked-package-installer.js';
import './installers/source-package-installer.js';
import './installers/managed-package-installer.js';

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
  tasks?: InstallTaskRegistration[];
}

/**
 * Orchestrator for package installations
 */
export {PackageInstaller};
export default class PackageInstaller {
  public readonly bus: InstallEventBus;
  public readonly targetOrg: Org;
  private options: InstallOptions;
  private provider: ProjectDefinitionProvider;
  private readonly rootLogger: Logger | undefined;

  constructor(
    targetOrg: Org,
    provider: ProjectDefinitionProvider,
    options: InstallOptions,
    logger?: Logger,
    bus?: InstallEventBus,
  ) {
    this.options = options;
    this.rootLogger = logger;
    this.provider = provider;
    this.targetOrg = targetOrg;
    this.bus = bus ?? new InstallEventBus();
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
    const logger = this.rootLogger?.child?.({package: packageName}) ?? this.rootLogger;
    const factory = new PackageFactory(this.provider);

    if (!this.targetOrg) {
      throw new Error('Target org not connected. Call connect() before installing packages.');
    }

    const targetOrg = this.targetOrg.getUsername()!;

    // Managed packages: skip artifact resolution, go straight to version install
    if (factory.isManagedPackage(packageName)) {
      const managedRef = factory.createManagedRef(packageName);
      if (!managedRef) {
        throw new InstallationError(
          packageName,
          targetOrg,
          `Managed package ${packageName} could not be resolved from project aliases`,
        );
      }

      return this.installManagedPackage(managedRef, logger);
    }

    const sfpmPackage = factory.createFromName(packageName);

    if (!sfpmPackage) {
      throw new InstallationError(packageName, targetOrg, `Package ${packageName} not found in project configuration`);
    }

    try {
      return await this.installPackage(sfpmPackage, logger);
    } catch (error) {
      logger?.error(`Failed to install ${packageName}: ${error instanceof Error ? error.message : String(error)}`);

      if (error instanceof InstallationError) throw error;
      throw new InstallationError(packageName, targetOrg, error instanceof Error ? error.message : String(error), {
        cause: error instanceof Error ? error : new Error(String(error)),
      });
    }
  }

  /**
   * Fast path for managed packages — no artifact resolution needed.
   * Uses the packageVersionId already known from packageAliases.
   *
   * Managed packages have no hooks or tasks, so they use a separate
   * path from {@link runInstaller}. The install-check is handled via
   * the installer's {@link Installer.isInstalled} method.
   */
  public async installManagedPackage(managedRef: ManagedPackageRef, logger?: Logger): Promise<InstallResult> {
    const {packageName} = managedRef;
    const sink = this.bus.forPackage(packageName);

    const installer = installerFactory(managedRef, this.options, logger, sink);
    await installer.connect(this.targetOrg);

    // Check if already installed (unless forced)
    if (!this.options.force) {
      const check = await installer.isInstalled();
      if (!check.needsInstall) {
        const reason = `Version ${managedRef.packageVersionId} already installed`;
        logger?.info(`Skipping managed package ${packageName}: ${reason}`);
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
      logger?.info(`Successfully installed managed package ${packageName}`);

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
      logger?.error(`Failed to install managed package ${packageName}: ${error instanceof Error ? error.message : String(error)}`);
      // One log line per item when the failure has a structured breakdown —
      // grep-able individually, instead of one giant joined-string entry.
      for (const detail of extractErrorDetails(error) ?? []) {
        logger?.error(`${detail.label}: ${detail.message}`);
      }

      // Separate boundary from install() — managed packages are returned
      // directly from install(), bypassing its try/catch, so this needs its
      // own wrap to keep the "always InstallationError" guarantee.
      if (error instanceof InstallationError) throw error;
      throw new InstallationError(
        packageName,
        this.targetOrg.getUsername()!,
        error instanceof Error ? error.message : String(error),
        {cause: error instanceof Error ? error : new Error(String(error))},
      );
    }
  }

  /**
   * Install sfpmPackage
   */
  public async installPackage(sfpmPackage: SfpmPackage, logger?: Logger): Promise<InstallResult> {
    const packageName = sfpmPackage.name;

    if (!packageName) {
      throw new Error(`Package "${packageName}" has no npm name. `
        + 'In workspace mode, this is set from the package.json "name" field. '
        + 'Run `sfpm init turbo` to migrate from sfdx-project.json.');
    }

    logger?.info(`Installing ${packageName}@${sfpmPackage.version}`);

    return this.runInstaller(sfpmPackage, {
      checkInstalled: !this.options.force,
      installAs: this.resolveInstallAs(sfpmPackage),
      tasks: [
        {
          factory: ctx => new UpdateArtifactTask(ctx),
          phase: 'post',
        },
      ],
    }, logger);
  }

  /**
   * Determine if an unlocked package should be routed to the source installer.
   * Returns undefined for non-unlocked packages (use natural type).
   */
  private resolveInstallAs(sfpmPackage: SfpmPackage): PackageType | undefined {
    if (sfpmPackage.type !== PackageType.Unlocked) return undefined;
    if (this.options.unlocked?.sourceOnly) return PackageType.Source;
    if (!(sfpmPackage as SfpmUnlockedPackage).packageVersionId) return PackageType.Source;
    return undefined;
  }

  private async runHooks(timing: HookTiming, sfpmPackage: SfpmPackage, sink?: InstallEventSink, logger?: Logger): Promise<void> {
    if (!LifecycleEngine.isInitialized()) return;

    const lifecycle = LifecycleEngine.getInstance();
    const hookContext: HookContext = {
      logger,
      operation: 'install',
      projectDir: this.provider.projectDir,
      provider: this.provider,
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
  private async runInstaller(sfpmPackage: SfpmPackage, options: RunInstallerOptions, logger?: Logger): Promise<InstallResult> {
    const sink = this.bus.forPackage(sfpmPackage.name);

    const installer = installerFactory(sfpmPackage, this.options, logger, sink, options.installAs);
    await installer.connect(this.targetOrg);

    // Check if already installed
    if (options.checkInstalled) {
      const check = await installer.isInstalled();
      if (!check.needsInstall) {
        logger?.info(`Skipping ${sfpmPackage.name}@${sfpmPackage.version}: ${check.installReason}`);
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
      await this.runHooks('pre', sfpmPackage, sink, logger);

      await this.runTasks(options.tasks, 'pre', {
        sfpmPackage,
        targetOrg: this.targetOrg,
        workingDirectory: this.provider.projectDir,
      }, logger);

      const result = await installer.run();

      sink?.complete({
        packageType: sfpmPackage.type as PackageType,
        success: true,
        targetOrg: this.targetOrg.getUsername()!,
        versionNumber: sfpmPackage.version,
      });
      logger?.info(`Successfully installed ${sfpmPackage.name}@${sfpmPackage.version}`);

      await this.runTasks(options.tasks, 'post', {
        installId: result.installId,
        sfpmPackage,
        targetOrg: this.targetOrg,
        workingDirectory: this.provider.projectDir,
      }, logger);

      await this.runHooks('post', sfpmPackage, sink, logger);

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
      logger?.error(`Failed to install ${sfpmPackage.name}: ${error instanceof Error ? error.message : String(error)}`);
      // One log line per item when the failure has a structured breakdown —
      // grep-able individually, instead of one giant joined-string entry.
      for (const detail of extractErrorDetails(error) ?? []) {
        logger?.error(`${detail.label}: ${detail.message}`);
      }

      throw error;
    }
  }

  /**
   * Run task registrations sequentially.
   */
  private async runTasks(tasks: InstallTaskRegistration[] | undefined, phase: 'post' | 'pre', ctx: InstallTaskContext, logger?: Logger): Promise<void> {
    if (!tasks) {
      return;
    }

    for (const registration of tasks) {
      const task = registration.factory(ctx);
      const taskName = task.name;

      // Check runtime precondition
      if (task.canRun && !task.canRun()) {
        logger?.debug(`Skipping task '${taskName}': precondition not met`);
        continue;
      }

      logger?.debug(`Running ${phase} task: ${taskName}`);

      // eslint-disable-next-line no-await-in-loop -- tasks run sequentially, stop on first failure
      await task.exec();
    }
  }
}
