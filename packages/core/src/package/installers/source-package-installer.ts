import {Org} from '@salesforce/core';

import type {InstallEventSink} from '../../events/install-event-bus.js';

import {MetadataDeployService} from '../../tooling/metadata-deploy-service.js';
import {Logger} from '../../types/logger.js';
import {PackageType} from '../../types/package.js';
import {resolveOrgType} from '../../utils/org-utils.js';
import PackageManager from '../package-manager.js';
import {SfpmMetadataPackage} from '../sfpm-package.js';
import {
  type InstallCheckResult, Installer, type InstallerResult, RegisterInstaller,
} from './installer-registry.js';

export interface SourcePackageInstallerOptions {
  /** Salesforce test level for the deployment */
  testLevel?: string;
}

/**
 * Adapter that bridges {@link SfpmMetadataPackage} with the
 * {@link SourceDeployer} strategy. Source packages always use source
 * deployment — there is no version-install path.
 */
// eslint-disable-next-line new-cap
@RegisterInstaller(PackageType.Source)
export default class SourcePackageInstaller implements Installer {
  private readonly logger?: Logger;
  private readonly options?: SourcePackageInstallerOptions;
  private readonly sfpmPackage: SfpmMetadataPackage;
  private readonly sink?: InstallEventSink;
  private targetOrg?: Org;

  constructor(
    sfpmPackage: SfpmMetadataPackage,
    options?: SourcePackageInstallerOptions,
    logger?: Logger,
    sink?: InstallEventSink,
  ) {
    this.sfpmPackage = sfpmPackage;
    this.options = options;
    this.logger = logger;
    this.sink = sink;
  }

  public async connect(targetOrg: Org): Promise<void> {
    const username = targetOrg.getUsername();

    if (!username) {
      throw new Error('Target org must have a valid username');
    }

    this.sink?.connectionStart({orgType: await resolveOrgType(targetOrg), username});
    this.targetOrg = targetOrg;
    this.sink?.connectionComplete({username});
  }

  public async isInstalled(): Promise<InstallCheckResult> {
    this.requireTargetOrg();

    const manager = PackageManager.getInstance(this.targetOrg!);
    return manager.isInstalled(this.sfpmPackage);
  }

  public async run(): Promise<InstallerResult> {
    this.requireTargetOrg();

    const {componentSet} = this.sfpmPackage;
    // eslint-disable-next-line @typescript-eslint/no-non-null-asserted-optional-chain -- checked in requireTargetOrg()
    const username = this.targetOrg?.getUsername()!;

    this.logger?.debug(`Using source deployment strategy for package: ${this.sfpmPackage.name}`);
    this.logger?.debug(`Deploying source to ${username}`);

    this.sink?.deployStart({targetOrg: username});

    const deployService = new MetadataDeployService(this.targetOrg!, this.logger);

    const deployId = await deployService.deploy(componentSet, {
      testLevel: this.options?.testLevel as 'NoTestRun' | 'RunLocalTests' | 'RunSpecifiedTests' | undefined,
    });

    const result = await deployService.awaitDeploy(deployId, progress => {
      this.sink?.deployProgress({status: progress.status});
    });

    if (!result.success) {
      const errorMessages = result.formatErrors() || 'Unknown deployment error';
      this.sink?.deployComplete({targetOrg: username});
      throw new Error(`Source deployment failed:\n${errorMessages}`);
    }

    this.sink?.deployComplete({targetOrg: username});
    this.logger?.debug('Source deployment completed successfully');

    return {installId: deployId};
  }

  private requireTargetOrg(): void {
    if (!this.targetOrg) {
      throw new Error('Ensure to conect to target org before runnnig installer');
    }
  }
}
