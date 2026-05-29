import type {InstallEventSink} from '../../../events/install-event-bus.js';

import {MetadataDeployService} from '../../../tooling/metadata-deploy-service.js';
import {Logger} from '../../../types/logger.js';
import {type SourceDeployable} from '../types.js';

/**
 * Deploys a package's source via the Metadata API using {@link MetadataDeployService}.
 *
 * This is a pure strategy — it knows nothing about SfpmPackage or routing.
 * The caller (an installer acting as adapter) is responsible for building the
 * {@link SourceDeployable} payload and deciding when this strategy applies.
 */
export default class SourceDeployer {
  private logger?: Logger;
  private sink?: InstallEventSink;

  constructor(logger?: Logger, sink?: InstallEventSink) {
    this.logger = logger;
    this.sink = sink;
  }

  public async install(deployable: SourceDeployable, targetOrg: string, options?: {testLevel?: string}): Promise<{deployId?: string}> {
    const {componentSet} = deployable;

    this.logger?.info(`Using source deployment strategy for package: ${deployable.packageName}`);
    this.logger?.info(`Deploying source to ${targetOrg}`);

    this.sink?.deployStart({targetOrg});

    const deployService = new MetadataDeployService(this.logger);

    const deployId = await deployService.deploy(componentSet, targetOrg, {
      testLevel: options?.testLevel as 'NoTestRun' | 'RunLocalTests' | 'RunSpecifiedTests' | undefined,
    });

    const result = await deployService.awaitDeploy(deployId, targetOrg, progress => {
      this.sink?.deployProgress({status: progress.status});
    });

    if (!result.success) {
      const errorMessages = result.formatErrors() || 'Unknown deployment error';
      this.sink?.deployComplete({targetOrg});
      throw new Error(`Source deployment failed:\n${errorMessages}`);
    }

    this.sink?.deployComplete({targetOrg});
    this.logger?.info('Source deployment completed successfully');

    return {deployId};
  }
}
