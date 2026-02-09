import {Org} from '@salesforce/core';
import EventEmitter from 'node:events';

import {Logger} from '../../types/logger.js';
import {InstallationMode, InstallationSource, PackageType} from '../../types/package.js';
import SfpmPackage, {SfpmManagedPackage} from '../sfpm-package.js';
import {Installer, RegisterInstaller} from './installer-registry.js';
import VersionInstallStrategy from './strategies/version-install-strategy.js';

/**
 * Installer for managed (external/subscriber) packages.
 *
 * Managed packages always use version-install via the Tooling API — there
 * is no local source to deploy.  The only strategy is
 * {@link VersionInstallStrategy}.
 */
@RegisterInstaller(PackageType.Managed)
export default class ManagedPackageInstaller extends EventEmitter implements Installer {
  private readonly logger?: Logger;
  private org?: Org;
  private readonly sfpmPackage: SfpmManagedPackage;
  private readonly strategy: VersionInstallStrategy;
  private readonly targetOrg: string;

  constructor(targetOrg: string, sfpmPackage: SfpmPackage, logger?: Logger) {
    super();
    if (!(sfpmPackage instanceof SfpmManagedPackage)) {
      throw new TypeError(`ManagedPackageInstaller received incompatible package type: ${sfpmPackage.constructor.name}`);
    }

    this.targetOrg = targetOrg;
    this.sfpmPackage = sfpmPackage;
    this.logger = logger;
    this.strategy = new VersionInstallStrategy(logger, this);
  }

  public async connect(username: string): Promise<void> {
    this.emit('connection:start', {
      targetOrg: username,
      timestamp: new Date(),
    });

    this.org = await Org.create({aliasOrUsername: username});

    if (!this.org.getConnection()) {
      throw new Error('Unable to connect to org');
    }

    this.emit('connection:complete', {
      targetOrg: username,
      timestamp: new Date(),
    });
  }

  public async exec(): Promise<void> {
    this.logger?.info(`Installing managed package: ${this.sfpmPackage.packageName}`);
    await this.strategy.install(this.sfpmPackage, this.targetOrg);
  }
}
