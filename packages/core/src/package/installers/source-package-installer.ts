import {Org} from '@salesforce/core';
import EventEmitter from 'node:events';

import {ArtifactService} from '../../artifacts/artifact-service.js';
import {Logger} from '../../types/logger.js';
import {InstallationSource, PackageType} from '../../types/package.js';
import {SfpmSourcePackage} from '../sfpm-package.js';
import {Installer, type InstallerExecResult, RegisterInstaller} from './installer-registry.js';
// Import strategy implementation
import SourceDeployer from './strategies/source-deployer.js';

export interface SourcePackageInstallerOptions {
  /** Where the code comes from: 'local' (project source) or 'artifact' */
  source?: InstallationSource;
}

export interface InstallTask {
  exec(): Promise<void>;
}

/**
 * Adapter that bridges {@link SfpmSourcePackage} with the
 * {@link SourceDeployer} strategy. Source packages always use source
 * deployment — there is no version-install path.
 */
// eslint-disable-next-line new-cap
@RegisterInstaller(PackageType.Source)
export default class SourcePackageInstaller extends EventEmitter implements Installer {
  public postInstallTasks: InstallTask[] = [];
  public preInstallTasks: InstallTask[] = [];
  private readonly artifactService: ArtifactService;
  private readonly logger?: Logger;
  private org?: Org;
  private readonly sfpmPackage: SfpmSourcePackage;
  private readonly source: InstallationSource;
  private readonly sourceDeployer: SourceDeployer;
  private readonly targetOrg: string;

  constructor(targetOrg: string, sfpmPackage: SfpmSourcePackage, logger?: Logger, options?: SourcePackageInstallerOptions) {
    super();
    if (!(sfpmPackage instanceof SfpmSourcePackage)) {
      throw new TypeError(`SourcePackageInstaller received incompatible package type: ${(sfpmPackage as unknown as {constructor: {name: string}}).constructor.name}`);
    }

    this.targetOrg = targetOrg;
    this.sfpmPackage = sfpmPackage;
    this.logger = logger;

    // Initialize artifact service
    this.artifactService = new ArtifactService(logger);

    // Source packages always use source deployment
    this.sourceDeployer = new SourceDeployer(logger, this);

    // Determine source
    this.source = this.determineSource(options);
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

  public async exec(): Promise<InstallerExecResult> {
    this.logger?.info(`Installing source package: ${this.sfpmPackage.packageName}`);

    await this.runPreInstallTasks();
    const result = await this.installPackage();
    await this.runPostInstallTasks();

    return result;
  }

  // ---------------------------------------------------------------------------
  // Private
  // ---------------------------------------------------------------------------

  private determineSource(options?: SourcePackageInstallerOptions): InstallationSource {
    if (options?.source) {
      return options.source;
    }

    // Auto-detect: if artifacts exist, use artifact; otherwise local
    const repo = this.artifactService.getRepository(this.sfpmPackage.projectDirectory);
    if (repo.hasArtifacts(this.sfpmPackage.packageName)) {
      return InstallationSource.Artifact;
    }

    return InstallationSource.Local;
  }

  private async installPackage(): Promise<InstallerExecResult> {
    this.logger?.info('Using installation mode: source-deploy');
    // SfpmSourcePackage implements SourceDeployable via SfpmMetadataPackage
    return this.sourceDeployer.install(this.sfpmPackage, this.targetOrg);
  }

  private async runPostInstallTasks(): Promise<void> {
    for (const task of this.postInstallTasks) {
      const taskName = task.constructor.name;
      this.logger?.info(`Running post-install task: ${taskName}`);
      // Tasks must run sequentially (order matters for pre/post hooks)
      // eslint-disable-next-line no-await-in-loop
      await task.exec();
    }
  }

  private async runPreInstallTasks(): Promise<void> {
    for (const task of this.preInstallTasks) {
      const taskName = task.constructor.name;
      this.logger?.info(`Running pre-install task: ${taskName}`);
      // Tasks must run sequentially (order matters for pre/post hooks)
      // eslint-disable-next-line no-await-in-loop
      await task.exec();
    }
  }
}
