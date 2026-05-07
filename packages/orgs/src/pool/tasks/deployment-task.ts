import {
  InstallationMode,
  InstallOrchestrator,
  type Logger,
  ProjectService,
  type TestLevel,
} from '@b64/sfpm-core';

import type {PoolOrg} from '../../org/pool-org.js';
import type {PoolOrgTask, PoolOrgTaskResult} from '../types.js';

/**
 * Options for the deployment task.
 */
export interface DeploymentTaskOptions {
  /** Whether to continue provisioning if deployment fails */
  continueOnError?: boolean;
  /** Deploy all packages except these (full npm names) */
  exclude?: string[];
  /** Only deploy these packages (full npm names). Takes precedence over `exclude`. */
  include?: string[];
  /** Root project directory (contains sfdx-project.json or workspace package.json) */
  projectDirectory: string;
  /** Skip updating Sfpm_Artifact__c after deployment */
  skipArtifactUpdate?: boolean;
  /** Apex test level (default: NoTestRun) */
  testLevel?: string;
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
  private readonly options: DeploymentTaskOptions;

  constructor(options: DeploymentTaskOptions) {
    this.options = options;
    this.continueOnError = options.continueOnError ?? false;
  }

  async execute(org: PoolOrg, logger: Logger): Promise<PoolOrgTaskResult> {
    const {username} = org.auth;

    if (!username) {
      return {error: 'Org has no username', success: false};
    }

    const projectService = await ProjectService.getInstance(this.options.projectDirectory);
    const provider = projectService.getDefinitionProvider();
    const graph = projectService.getProjectGraph();

    const packages = this.resolvePackages(provider.getAllPackageNames(), logger);

    if (packages.length === 0) {
      logger.info('No packages to deploy — skipping deployment');
      return {success: true};
    }

    logger.info(`Deploying ${packages.length} package(s) to ${username}`);

    const orchestrator = InstallOrchestrator.forArtifact(provider, graph, {
      deployment: {testLevel: (this.options.testLevel ?? 'NoTestRun') as TestLevel},
      force: true,
      mode: InstallationMode.SourceDeploy,
      targetOrg: username,
      trackHistory: !this.options.skipArtifactUpdate,
    }, logger);

    const result = await orchestrator.installAll(packages);

    if (!result.success) {
      const failed = result.failedPackages.join(', ');
      return {error: `Failed to deploy: ${failed}`, success: false};
    }

    return {success: true};
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
