import {Org} from '@salesforce/core';

import type {InstallEventSink} from '../../events/install-event-bus.js';

import Logger from '../../types/logger.js';
import {type InstallOptions, PackageType} from '../../types/package.js';
import {resolveOrgType} from '../../utils/org-utils.js';
import PackageManager from '../package-manager.js';
import {SfpmUnlockedPackage} from '../sfpm-package.js';
import {
  type InstallCheckResult, Installer, type InstallerResult, RegisterInstaller,
} from './installer-registry.js';

/**
 * Installs unlocked packages via subscriber version ID (04t) through
 * the Salesforce Tooling API.
 *
 * This installer only handles version installs. Source deployment of
 * unlocked packages is routed to {@link SourcePackageInstaller} by the
 * {@link PackageInstaller} orchestrator via the `installAs` mechanism.
 */
// eslint-disable-next-line new-cap
@RegisterInstaller(PackageType.Unlocked)
export default class UnlockedPackageInstaller implements Installer {
  private readonly logger?: Logger;
  private readonly options?: InstallOptions;
  private readonly sfpmPackage: SfpmUnlockedPackage;
  private readonly sink?: InstallEventSink;
  private targetOrg?: Org;

  constructor(
    sfpmPackage: SfpmUnlockedPackage,
    options?: InstallOptions,
    logger?: Logger,
    sink?: InstallEventSink,
  ) {
    if (!(sfpmPackage instanceof SfpmUnlockedPackage)) {
      throw new TypeError(`UnlockedPackageInstaller received incompatible package type: ${(sfpmPackage as unknown as {constructor: {name: string}}).constructor.name}`);
    }

    this.sfpmPackage = sfpmPackage;
    this.logger = logger;
    this.options = options;
    this.sink = sink;
  }

  public async connect(targetOrg: Org): Promise<void> {
    const username = targetOrg.getUsername();
    if (!username) {
      throw new Error('Target org must have a valid username');
    }

    this.targetOrg = targetOrg;

    const orgType = await resolveOrgType(targetOrg);
    if (orgType) {
      this.sink?.connectionStart({orgType, username});
    }

    this.sink?.connectionComplete({username});
  }

  public async isInstalled(): Promise<InstallCheckResult> {
    this.requireTargetOrg();

    const manager = PackageManager.getInstance(this.targetOrg!);
    return manager.isInstalled(this.sfpmPackage);
  }

  public async run(): Promise<InstallerResult> {
    this.requireTargetOrg();

    const {packageName, packageVersionId} = this.sfpmPackage;

    if (!packageVersionId) {
      throw new Error(`Unlocked package ${packageName} has no packageVersionId. `
        + 'Route to source installer instead, or build a package version first.');
    }

    this.logger?.info(`Installing unlocked package ${packageName} via version install (${packageVersionId})`);

    const packageService = PackageManager.getInstance(this.targetOrg!).getPackageService();

    const installationKey = this.options?.unlocked?.installationKey;

    const result = await packageService.installPackage(packageVersionId, {
      installationKey,
      wait: 30,
    });

    return {installId: result.Id};
  }

  private requireTargetOrg(): void {
    if (!this.targetOrg) {
      throw new Error('Target org not connected. Call connect() before running installer.');
    }
  }
}

