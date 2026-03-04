import {Org} from '@salesforce/core';
import EventEmitter from 'node:events';

import {
  type Installer,
  type Logger,
  PackageType,
  RegisterInstaller,
  SfpmDataPackage,
  type SfpmPackage,
} from '@b64/sfpm-core';

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
  private readonly targetOrg: string;

  constructor(targetOrg: string, sfpmPackage: SfpmPackage, logger?: Logger) {
    super();
    if (!(sfpmPackage instanceof SfpmDataPackage)) {
      throw new TypeError(`SfdmuDataInstaller received incompatible package type: ${(sfpmPackage as any).constructor.name}`);
    }

    this.targetOrg = targetOrg;
    this.sfpmPackage = sfpmPackage;
    this.logger = logger;

    // Create the SFDMU strategy, forwarding events through this installer
    this.strategy = new SfdmuImportStrategy(logger, this);
  }

  /**
   * Validate target org connectivity.
   */
  public async connect(username: string): Promise<void> {
    this.emit('connection:start', {
      targetOrg: username,
      timestamp: new Date(),
    });

    this.org = await Org.create({aliasOrUsername: username});

    if (!this.org.getConnection()) {
      throw new Error('Unable to connect to target org');
    }

    this.emit('connection:complete', {
      targetOrg: username,
      timestamp: new Date(),
    });
  }

  /**
   * Execute the data import via SFDMU.
   */
  public async exec(): Promise<any> {
    this.logger?.info(`Installing data package: ${this.sfpmPackage.packageName}`);
    const result = await this.strategy.execute(this.sfpmPackage, this.targetOrg);
    return result;
  }
}
