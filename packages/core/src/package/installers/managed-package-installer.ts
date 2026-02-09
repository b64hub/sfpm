import {Org} from '@salesforce/core';
import EventEmitter from 'node:events';

import {Logger} from '../../types/logger.js';
import {PackageType} from '../../types/package.js';
import {Installer, RegisterInstaller} from './installer-registry.js';
import VersionInstaller from './strategies/version-installer.js';
import {ManagedPackageRef, type VersionInstallable} from './types.js';

/**
 * Adapter for managed (external/subscriber) packages.
 *
 * Managed packages always use version-install via the Tooling API — there
 * is no local source to deploy. The adapter simply forwards the
 * {@link VersionInstallable} payload (typically a {@link ManagedPackageRef})
 * to the {@link VersionInstaller}.
 */
@RegisterInstaller(PackageType.Managed)
export default class ManagedPackageInstaller extends EventEmitter implements Installer {
  private readonly installable: VersionInstallable;
  private readonly logger?: Logger;
  private org?: Org;
  private readonly targetOrg: string;

  constructor(targetOrg: string, managedPackage: ManagedPackageRef, logger?: Logger) {
    super();
    this.targetOrg = targetOrg;
    this.installable = managedPackage;
    this.logger = logger;
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
    this.logger?.info(`Installing managed package: ${this.installable.packageName}`);
    await new VersionInstaller(this.logger, this).install(this.installable, this.targetOrg);
  }
}
