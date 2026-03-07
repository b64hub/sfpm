
import {Org} from '@salesforce/core';
import EventEmitter from 'node:events';

import {ArtifactService} from '../../artifacts/artifact-service.js';
import {Logger} from '../../types/logger.js';
import {
  InstallationMode, InstallationSource, PackageType, SfpmUnlockedPackageBuildOptions,
} from '../../types/package.js';
import {SfpmUnlockedPackage} from '../sfpm-package.js';
import {Installer, RegisterInstaller} from './installer-registry.js';
// Import strategy implementations
import SourceDeployer from './strategies/source-deployer.js';
import VersionInstaller from './strategies/version-installer.js';
import {type VersionInstallable} from './types.js';

export interface UnlockedPackageInstallerOptions {
  installationKey?: string;
  /** Specify installation mode (overrides auto-detection) */
  mode?: InstallationMode;
  /** Where the code comes from: 'local' (project source) or 'artifact' */
  source?: InstallationSource;
}

export interface InstallTask {
  exec(): Promise<void>;
}

/**
 * Adapter that bridges {@link SfpmUnlockedPackage} with the typed installation
 * strategies ({@link VersionInstallStrategy} and {@link SourceDeployStrategy}).
 *
 * Routing logic (version-install vs source-deploy) lives here — the strategies
 * themselves are pure and accept only their typed payload.
 */
@RegisterInstaller(PackageType.Unlocked)
export default class UnlockedPackageInstaller extends EventEmitter implements Installer {
  public postInstallTasks: InstallTask[] = [];
  public preInstallTasks: InstallTask[] = [];
  private readonly artifactService: ArtifactService;
  private readonly logger?: Logger;
  private readonly mode?: InstallationMode;
  private org?: Org;
  private readonly sfpmPackage: SfpmUnlockedPackage;
  private readonly source: InstallationSource;
  private readonly sourceDeployer: SourceDeployer;
  private readonly targetOrg: string;
  private readonly versionInstaller: VersionInstaller;

  constructor(targetOrg: string, sfpmPackage: SfpmUnlockedPackage, logger?: Logger, options?: UnlockedPackageInstallerOptions) {
    super();
    if (!(sfpmPackage instanceof SfpmUnlockedPackage)) {
      throw new TypeError(`UnlockedPackageInstaller received incompatible package type: ${(sfpmPackage as any).constructor.name}`);
    }

    this.targetOrg = targetOrg;
    this.sfpmPackage = sfpmPackage;
    this.logger = logger;
    this.mode = options?.mode;

    // Initialize artifact service
    this.artifactService = new ArtifactService(logger);

    // Create strategy instances (pure — no routing logic)
    this.versionInstaller = new VersionInstaller(logger, this);
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

  public async exec(): Promise<void> {
    this.logger?.info(`Installing unlocked package: ${this.sfpmPackage.packageName}`);

    await this.runPreInstallTasks();
    await this.installPackage();
    await this.runPostInstallTasks();
  }

  // ---------------------------------------------------------------------------
  // Routing — decides which strategy to use and builds the typed payload
  // ---------------------------------------------------------------------------

  private determineSource(options?: UnlockedPackageInstallerOptions): InstallationSource {
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

  private async installPackage(): Promise<void> {
    const mode = this.resolveMode();
    this.logger?.info(`Using installation mode: ${mode}`);

    if (mode === InstallationMode.VersionInstall) {
      const installable = this.toVersionInstallable();
      await this.versionInstaller.install(installable, this.targetOrg);
    } else {
      // SfpmUnlockedPackage implements SourceDeployable via SfpmMetadataPackage
      await this.sourceDeployer.install(this.sfpmPackage, this.targetOrg);
    }
  }

  /**
   * Resolve the installation mode for this package.
   *
   * Explicit `mode` option takes precedence. Otherwise:
   * - Artifact source + packageVersionId → version-install
   * - Everything else → source-deploy (local, or artifact without versionId)
   */
  private resolveMode(): InstallationMode {
    if (this.mode) {
      return this.mode;
    }

    if (this.source === InstallationSource.Artifact && this.sfpmPackage.packageVersionId) {
      return InstallationMode.VersionInstall;
    }

    return InstallationMode.SourceDeploy;
  }

  // ---------------------------------------------------------------------------
  // Payload builders — adapt SfpmUnlockedPackage → typed strategy inputs
  // ---------------------------------------------------------------------------

  private async runPostInstallTasks(): Promise<void> {
    for (const task of this.postInstallTasks) {
      const taskName = task.constructor.name;
      this.logger?.info(`Running post-install task: ${taskName}`);
    }

    await Promise.all(this.postInstallTasks.map(task => task.exec()));
  }

  private async runPreInstallTasks(): Promise<void> {
    for (const task of this.preInstallTasks) {
      const taskName = task.constructor.name;
      this.logger?.info(`Running pre-install task: ${taskName}`);
    }

    await Promise.all(this.preInstallTasks.map(task => task.exec()));
  }

  private toVersionInstallable(): VersionInstallable {
    const versionId = this.sfpmPackage.packageVersionId;
    if (!versionId) {
      throw new Error(`Cannot version-install ${this.sfpmPackage.packageName}: no packageVersionId`);
    }

    const buildOptions = this.sfpmPackage.metadata?.orchestration?.buildOptions as SfpmUnlockedPackageBuildOptions | undefined;

    return {
      artifact: this.sfpmPackage.sourceHash && this.sfpmPackage.commitId
        ? {commitId: this.sfpmPackage.commitId, sourceHash: this.sfpmPackage.sourceHash, tag: this.sfpmPackage.tag}
        : undefined,
      installationKey: buildOptions?.installationKey,
      packageName: this.sfpmPackage.packageName,
      packageVersionId: versionId,
      versionNumber: this.sfpmPackage.version,
    };
  }
}
