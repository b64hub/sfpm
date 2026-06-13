
import {Org} from '@salesforce/core';

import type {InstallEventSink} from '../../events/install-event-bus.js';

import {ArtifactService} from '../../artifacts/artifact-service.js';
import {Logger} from '../../types/logger.js';
import {
  InstallationMode, PackageType, PerPackageBuildConfig,
} from '../../types/package.js';
import {PackageService} from '../package-service.js';
import {SfpmUnlockedPackage} from '../sfpm-package.js';
import {type InstallCheckResult, Installer, type InstallerResult, RegisterInstaller} from './installer-registry.js';
import {type InstallOptions} from '../../index.js';
// Import strategy implementations
import SourceDeployer from './strategies/source-deployer.js';
import VersionInstaller from './strategies/version-installer.js';
import {type VersionInstallable} from './types.js';

/**
 * Adapter that bridges {@link SfpmUnlockedPackage} with the typed installation
 * strategies ({@link VersionInstaller} and {@link SourceDeployer}).
 *
 * Routing logic (version-install vs source-deploy) lives here — the strategies
 * themselves are pure and accept only their typed payload.
 */
// eslint-disable-next-line new-cap
@RegisterInstaller(PackageType.Unlocked)
export default class UnlockedPackageInstaller implements Installer {
  private readonly logger?: Logger;
  private readonly mode?: InstallationMode;
  private org?: Org;
  private readonly sfpmPackage: SfpmUnlockedPackage;
  private readonly sink?: InstallEventSink;
  private readonly sourceDeployer: SourceDeployer;
  private readonly versionInstaller: VersionInstaller;

  constructor(_workingDirectory: string, sfpmPackage: SfpmUnlockedPackage, options?: InstallOptions, logger?: Logger, sink?: InstallEventSink) {
    if (!(sfpmPackage instanceof SfpmUnlockedPackage)) {
      throw new TypeError(`UnlockedPackageInstaller received incompatible package type: ${(sfpmPackage as unknown as {constructor: {name: string}}).constructor.name}`);
    }

    this.sfpmPackage = sfpmPackage;
    this.logger = logger;
    this.mode = options?.mode;
    this.sink = sink;

    // Create strategy instances (pure — no routing logic)
    this.versionInstaller = new VersionInstaller(logger, sink);
    this.sourceDeployer = new SourceDeployer(logger, sink);
  }

  public async connect(targetOrg: Org): Promise<void> {
    this.org = targetOrg;

    const username = targetOrg.getUsername()!;
    this.sink?.connectionStart({orgType: 'production', username});
    this.sink?.connectionComplete({username});
  }

  public async isInstalled(): Promise<InstallCheckResult> {
    try {
      // 1. Check ArtifactService for hash match (takes precedence)
      const sourceHash = this.sfpmPackage.metadata.source?.sourceHash;
      if (sourceHash) {
        const artifactService = ArtifactService.getInstance();
        const installedArtifacts = await artifactService.getInstalledPackages();
        const installed = installedArtifacts.find(a => a.name === this.sfpmPackage.name);

        if (installed?.checksum && installed.checksum === sourceHash) {
          this.logger?.info(`Unlocked package ${this.sfpmPackage.name} already installed with matching hash ${sourceHash}`);
          return {installReason: 'hash-match', needsInstall: false};
        }
      }

      // 2. Fallback: check PackageService for 04t version
      const packageVersionId = this.sfpmPackage.packageVersionId;
      if (packageVersionId) {
        const packageService = PackageService.getInstance()
          .setOrg(this.org!);
        if (this.logger) packageService.setLogger(this.logger);

        const isVersionInstalled = await packageService.isSubscriberVersionInstalled(packageVersionId);
        if (isVersionInstalled) {
          this.logger?.info(`Unlocked package ${this.sfpmPackage.name} version ${packageVersionId} already installed`);
          return {installReason: 'version-installed', needsInstall: false};
        }
      }

      return {installReason: 'not-installed', needsInstall: true};
    } catch (error) {
      this.logger?.warn(`Unable to check if ${this.sfpmPackage.name} is installed, proceeding with install: ${error instanceof Error ? error.message : String(error)}`);
      return {installReason: 'check-failed', needsInstall: true};
    }
  }

  public async run(): Promise<InstallerResult> {
    this.logger?.info(`Installing unlocked package: ${this.sfpmPackage.packageName}`);
    const result = await this.installPackage();
    return result;
  }

  // ---------------------------------------------------------------------------
  // Routing — decides which strategy to use and builds the typed payload
  // ---------------------------------------------------------------------------

  private async installPackage(): Promise<InstallerResult> {
    const mode = this.resolveMode();
    this.logger?.info(`Using installation mode: ${mode}`);

    const targetOrg = this.org!.getUsername()!;

    if (mode === InstallationMode.VersionInstall) {
      const installable = this.toVersionInstallable();
      const result = await this.versionInstaller.install(installable, targetOrg);
      return {installId: result.deployId};
    }

    // SfpmUnlockedPackage implements SourceDeployable via SfpmMetadataPackage
    const result = await this.sourceDeployer.install(this.sfpmPackage, targetOrg);
    return {installId: result.deployId};
  }

  /**
   * Resolve the installation mode for this package.
   *
   * Explicit `mode` option takes precedence. Otherwise:
   * - packageVersionId available → version-install
   * - Everything else → source-deploy
   */
  private resolveMode(): InstallationMode {
    if (this.mode) {
      return this.mode;
    }

    if (this.sfpmPackage.packageVersionId) {
      return InstallationMode.VersionInstall;
    }

    return InstallationMode.SourceDeploy;
  }

  // ---------------------------------------------------------------------------
  // Payload builders — adapt SfpmUnlockedPackage → typed strategy inputs
  // ---------------------------------------------------------------------------

  private toVersionInstallable(): VersionInstallable {
    const versionId = this.sfpmPackage.packageVersionId;
    if (!versionId) {
      throw new Error(`Cannot version-install ${this.sfpmPackage.packageName}: no packageVersionId`);
    }

    const buildOptions = this.sfpmPackage.metadata?.orchestration?.build as PerPackageBuildConfig | undefined;

    return {
      installationKey: buildOptions?.installationKey,
      packageName: this.sfpmPackage.packageName,
      packageVersionId: versionId,
      versionNumber: this.sfpmPackage.version,
    };
  }
}
