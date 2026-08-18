import {
  ArtifactProvider,
  InstallOrchestrator,
  type Logger,
  PackageInstaller,
  ProjectService,
  type TestLevel,
  WorkspaceProvider,
} from '@b64hub/sfpm-core';
import {Org} from '@salesforce/core';

import type {PoolOrg} from '../../org/pool-org.js';
import type {PoolOrgTask, PoolOrgTaskResult} from '../types.js';

/**
 * Minimal interface for forwarding per-package progress events to the pool manager.
 * Injected via `setPackageForwarder()` before task execution.
 */
export interface PoolPackageForwarder {
  packageComplete(payload: {
    packageName: string;
    success: boolean;
    total: number;
    username: string;
    version?: string;
  }): void;
  packageStart(payload: {packageName: string; total: number; username: string}): void;
}

/**
 * Options for the deployment task.
 */
export interface DeploymentTaskOptions {
  /** Whether to continue provisioning if deployment fails */
  continueOnError: boolean;
  /** Deploy all packages except these (full npm names) */
  exclude?: string[];
  /** Only deploy these packages (full npm names). Takes precedence over `exclude`. */
  include?: string[];
  /** Apex test level (default: NoTestRun) */
  testLevel?: string;
  /** Deploy from local project source instead of downloaded artifacts */
  useLocalSource?: boolean;
  /** Root project directory (contains sfdx-project.json or workspace package.json) */
  workingDirectory: string;
}

/**
 * Pool task that deploys built artifacts to a provisioned org.
 *
 * Uses the core `InstallOrchestrator` to resolve artifacts from the
 * project's artifact directory, deploy them via the Metadata API in
 * dependency order, and update `Sfpm_Artifact__c` tracking records.
 *
 * When no packages match the include/exclude filter, the task succeeds
 * with a no-op — this allows pool provisioning to work even when no
 * artifacts have been built yet.
 */
export class DeploymentTask implements PoolOrgTask {
  public readonly continueOnError: boolean;
  public readonly name = 'deploy-packages';
  private forwarder?: PoolPackageForwarder;
  private readonly options: DeploymentTaskOptions;
  private projectServicePromise?: Promise<ProjectService>;

  constructor(options: DeploymentTaskOptions) {
    this.options = options;
    this.continueOnError = options.continueOnError;
  }

  async execute(org: PoolOrg, logger: Logger): Promise<PoolOrgTaskResult> {
    const {username} = org.auth;

    if (!username) {
      return {error: 'Org has no username', success: false};
    }

    const targetOrg = await Org.create({aliasOrUsername: username});

    const projectService = await this.getProjectService();
    const provider = projectService.getDefinitionProvider();
    const graph = projectService.getProjectGraph();

    const packages = this.resolvePackages(provider.getAllPackageNames(), logger);

    if (packages.length === 0) {
      logger.info('No packages to deploy — skipping deployment');
      return {success: true};
    }

    logger.info(`Deploying ${packages.length} package(s) to ${username}`);

    const installer = new PackageInstaller(
      targetOrg,
      provider,
      {force: true, testLevel: (this.options.testLevel ?? 'NoTestRun') as TestLevel, unlocked: {sourceOnly: true}},
      logger,
    );

    const orchestrator = new InstallOrchestrator(
      graph,
      installer,
      {
        continueOnError: true,
        includeManagedPackages: true,
      },
      logger,
    );

    if (this.forwarder) {
      let total = 0;
      const versionBuffer = new Map<string, string>();
      const fw = this.forwarder;

      orchestrator.orchestrationBus.on('start' as any, (e: any) => {
        total = (e.levels as string[][]).flat().length;
      });
      orchestrator.installBus.on('start' as any, (e: any) => {
        fw.packageStart({packageName: e.packageName as string, total, username: username!});
      });
      orchestrator.installBus.on('complete' as any, (e: any) => {
        if (e.versionNumber) versionBuffer.set(e.packageName as string, e.versionNumber as string);
      });
      orchestrator.orchestrationBus.on('package:complete' as any, (e: any) => {
        fw.packageComplete({
          packageName: e.packageName as string,
          success: !e.skipped && Boolean(e.success),
          total,
          username: username!,
          version: versionBuffer.get(e.packageName as string),
        });
        versionBuffer.delete(e.packageName as string);
      });
    }

    const result = await orchestrator.installAll(packages);

    if (!result.success) {
      const failed = result.failedPackages.join(', ');
      return {error: `Failed to deploy: ${failed}`, success: false};
    }

    return {success: true};
  }

  public setPackageForwarder(forwarder: PoolPackageForwarder): void {
    this.forwarder = forwarder;
  }

  /**
   * Resolve the provider matching `useLocalSource`:
   * - `true` — {@link WorkspaceProvider} (dist-aware) deploying live project source.
   * - `false` (default) — {@link ArtifactProvider} reading published artifacts
   *   already installed into `workingDirectory`'s `node_modules`.
   *
   * Cached per task instance since the same task runs once per pool org.
   */
  private getProjectService(): Promise<ProjectService> {
    this.projectServicePromise ??= this.options.useLocalSource
      ? ProjectService.create(
        this.options.workingDirectory,
        new WorkspaceProvider({distAware: true, projectDir: this.options.workingDirectory}),
      )
      : ProjectService.create(
        this.options.workingDirectory,
        new ArtifactProvider({projectDir: this.options.workingDirectory}),
      );

    return this.projectServicePromise;
  }

  /**
   * Filter packages based on include/exclude options.
   */
  private resolvePackages(allPackages: string[], logger: Logger): string[] {
    const {exclude, include} = this.options;

    if (include && include.length > 0) {
      const filtered = allPackages.filter(name => include.includes(name));
      logger.debug(`Include filter: ${filtered.length}/${allPackages.length} packages selected`);
      return filtered;
    }

    if (exclude && exclude.length > 0) {
      const filtered = allPackages.filter(name => !exclude.includes(name));
      logger.debug(`Exclude filter: ${filtered.length}/${allPackages.length} packages selected`);
      return filtered;
    }

    return allPackages;
  }
}
