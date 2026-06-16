import {
  type InstallCheckResult,
  type Installer,
  type InstallerResult,
  type Logger,
  PackageType,
  RegisterInstaller,
  SfpmDataPackage,
  type SfpmPackage,
} from '@b64hub/sfpm-core';
import {Org} from '@salesforce/core';
import EventEmitter from 'node:events';

import SfdmuImportStrategy from './strategies/sfdmu-import-strategy.js';

/**
 * Installer for SFDMU-based data packages.
 *
 * Bridges the core installer interface with the SFDMU import strategy.
 * Accepts an {@link SfpmDataPackage} (which implements {@link DataDeployable})
 * and delegates the actual data import to {@link SfdmuImportStrategy}.
 */
// eslint-disable-next-line new-cap
@RegisterInstaller(PackageType.Data)
export default class SfdmuDataInstaller extends EventEmitter implements Installer {
  private readonly logger?: Logger;
  private org?: Org;
  private readonly sfpmPackage: SfpmDataPackage;
  private readonly strategy: SfdmuImportStrategy;

  constructor(_workingDirectory: string, sfpmPackage: SfpmPackage, _options?: unknown, logger?: Logger) {
    super();
    if (!(sfpmPackage instanceof SfpmDataPackage)) {
      throw new TypeError(`SfdmuDataInstaller received incompatible package type: ${(sfpmPackage as any).constructor.name}`);
    }

    this.sfpmPackage = sfpmPackage;
    this.logger = logger;

    // Create the SFDMU strategy, forwarding events through this installer
    this.strategy = new SfdmuImportStrategy(logger, this);
  }

  public async connect(targetOrg: Org): Promise<void> {
    this.org = targetOrg;
  }

  public async isInstalled(): Promise<InstallCheckResult> {
    // Data packages are always installed (no skip logic)
    return {installReason: 'not-installed', needsInstall: true};
  }

  public async run(): Promise<InstallerResult> {
    this.logger?.info(`Installing data package: ${this.sfpmPackage.packageName}`);
    const targetOrg = this.org!.getUsername()!;
    await this.strategy.execute(this.sfpmPackage, targetOrg);
    return {};
  }
}
