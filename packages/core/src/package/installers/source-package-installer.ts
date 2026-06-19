import {Org} from '@salesforce/core';

import type {InstallEventSink} from '../../events/install-event-bus.js';

import {ArtifactService} from '../../artifacts/artifact-service.js';
import {Logger} from '../../types/logger.js';
import {PackageType} from '../../types/package.js';
import {SfpmSourcePackage} from '../sfpm-package.js';
import {
  type InstallCheckResult, Installer, type InstallerResult, RegisterInstaller,
} from './installer-registry.js';
// Import strategy implementation
import SourceDeployer from './strategies/source-deployer.js';

export interface SourcePackageInstallerOptions {
  /** Salesforce test level for the deployment */
  testLevel?: string;
}

/**
 * Adapter that bridges {@link SfpmSourcePackage} with the
 * {@link SourceDeployer} strategy. Source packages always use source
 * deployment — there is no version-install path.
 */
// eslint-disable-next-line new-cap
@RegisterInstaller(PackageType.Source)
export default class SourcePackageInstaller implements Installer {
  private readonly logger?: Logger;
  private org?: Org;
  private readonly sfpmPackage: SfpmSourcePackage;
  private readonly sink?: InstallEventSink;
  private readonly sourceDeployer: SourceDeployer;
  private readonly testLevel?: string;

  constructor(_workingDirectory: string, sfpmPackage: SfpmSourcePackage, options?: SourcePackageInstallerOptions, logger?: Logger, sink?: InstallEventSink) {
    if (!(sfpmPackage instanceof SfpmSourcePackage)) {
      throw new TypeError(`SourcePackageInstaller received incompatible package type: ${(sfpmPackage as unknown as {constructor: {name: string}}).constructor.name}`);
    }

    this.sfpmPackage = sfpmPackage;
    this.logger = logger;
    this.sink = sink;

    // Source packages always use source deployment
    this.sourceDeployer = new SourceDeployer(logger, sink);
    this.testLevel = options?.testLevel;
  }

  public async connect(targetOrg: Org): Promise<void> {
    this.org = targetOrg;

    const username = targetOrg.getUsername()!;
    this.sink?.connectionStart({orgType: 'production', username});
    this.sink?.connectionComplete({username});
  }

  public async isInstalled(): Promise<InstallCheckResult> {
    try {
      const {sourceHash} = this.sfpmPackage;
      if (!sourceHash) {
        return {installReason: 'not-installed', needsInstall: true};
      }

      const artifactService = ArtifactService.getInstance();
      const {isInstalled, versionNumber} = await artifactService.isArtifactInstalled(this.sfpmPackage.name);

      if (!isInstalled) {
        return {installReason: 'not-installed', needsInstall: true};
      }

      // Compare source hash against installed artifact checksum
      const installedArtifacts = await artifactService.getInstalledPackages();
      const installed = installedArtifacts.find(a => a.name === this.sfpmPackage.name);

      if (installed?.checksum && installed.checksum === sourceHash) {
        this.logger?.info(`Source package ${this.sfpmPackage.name} already installed with matching hash ${sourceHash}`);
        return {installReason: 'hash-match', needsInstall: false};
      }

      return {installReason: 'not-installed', needsInstall: true};
    } catch (error) {
      this.logger?.warn(`Unable to check if ${this.sfpmPackage.name} is installed, proceeding with install: ${error instanceof Error ? error.message : String(error)}`);
      return {installReason: 'check-failed', needsInstall: true};
    }
  }

  public async run(): Promise<InstallerResult> {
    this.logger?.info(`Installing source package: ${this.sfpmPackage.packageName}`);
    const targetOrg = this.org!.getUsername()!;
    const result = await this.sourceDeployer.install(this.sfpmPackage, targetOrg, {testLevel: this.testLevel});
    return {installId: result.deployId};
  }
}
