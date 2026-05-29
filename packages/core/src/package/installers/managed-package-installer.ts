import {Org} from '@salesforce/core';

import type {InstallEventSink} from '../../events/install-event-bus.js';

import {Logger} from '../../types/logger.js';
import {PackageType} from '../../types/package.js';
import {Installer, type InstallerExecResult, RegisterInstaller} from './installer-registry.js';
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
// eslint-disable-next-line new-cap
@RegisterInstaller(PackageType.Managed)
export default class ManagedPackageInstaller implements Installer {
  private readonly installable: VersionInstallable;
  private readonly logger?: Logger;
  private org?: Org;
  private readonly sink?: InstallEventSink;
  private readonly targetOrg: string;

  constructor(targetOrg: string, managedPackage: ManagedPackageRef, logger?: Logger, _options?: unknown, sink?: InstallEventSink) {
    this.targetOrg = targetOrg;
    this.installable = managedPackage;
    this.logger = logger;
    this.sink = sink;
  }

  public async connect(username: string): Promise<void> {
    this.sink?.connectionStart({orgType: 'production', username});

    this.org = await Org.create({aliasOrUsername: username});

    if (!this.org.getConnection()) {
      throw new Error('Unable to connect to org');
    }

    this.sink?.connectionComplete({username});
  }

  public async exec(): Promise<InstallerExecResult> {
    this.logger?.info(`Installing managed package: ${this.installable.packageName}`);
    return new VersionInstaller(this.logger, this.sink).install(this.installable, this.targetOrg);
  }
}
