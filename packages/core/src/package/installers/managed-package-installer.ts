import {Org} from '@salesforce/core';

import type {InstallEventSink} from '../../events/install-event-bus.js';

import {Logger} from '../../types/logger.js';
import {PackageType} from '../../types/package.js';
import PackageManager from '../package-manager.js';
import {
  type InstallCheckResult, Installer, type InstallerResult, RegisterInstaller,
} from './installer-registry.js';
import {ManagedPackageRef, type VersionInstallable} from './types.js';

/**
 * Installs managed (external/subscriber) packages via the Tooling API.
 *
 * Managed packages always use version-install — there is no local source
 * to deploy. Uses {@link PackageService.installPackage} directly.
 */
// eslint-disable-next-line new-cap
@RegisterInstaller(PackageType.Managed)
export default class ManagedPackageInstaller implements Installer {
  private readonly installable: ManagedPackageRef & VersionInstallable;
  private readonly logger?: Logger;
  private org?: Org;
  private readonly sink?: InstallEventSink;

  constructor(_workingDirectory: string, managedPackage: ManagedPackageRef, _options?: unknown, logger?: Logger, sink?: InstallEventSink) {
    this.installable = managedPackage;
    this.logger = logger;
    this.sink = sink;
  }

  public async connect(targetOrg: Org): Promise<void> {
    this.org = targetOrg;

    const username = targetOrg.getUsername()!;
    this.sink?.connectionStart({orgType: 'sandbox', username});
    this.sink?.connectionComplete({username});
  }

  public async isInstalled(): Promise<InstallCheckResult> {
    try {
      const packageService = PackageManager.getInstance(this.org!).getPackageService();

      const isInstalled = await packageService.isSubscriberVersionInstalled(this.installable.packageVersionId);

      if (isInstalled) {
        this.logger?.info(`Managed package ${this.installable.packageName} version ${this.installable.packageVersionId} already installed`);
        return {installReason: 'version-installed', needsInstall: false};
      }

      return {installReason: 'not-installed', needsInstall: true};
    } catch (error) {
      this.logger?.warn(`Unable to check if ${this.installable.packageName} is installed, proceeding with install: ${error instanceof Error ? error.message : String(error)}`);
      return {installReason: 'check-failed', needsInstall: true};
    }
  }

  public async run(): Promise<InstallerResult> {
    this.logger?.info(`Installing managed package: ${this.installable.packageName}`);

    const packageService = PackageManager.getInstance(this.org!).getPackageService();

    const result = await packageService.installPackage(this.installable.packageVersionId, {
      installationKey: this.installable.installationKey,
      wait: 30,
    });

    return {installId: result.Id};
  }
}
