import {EventEmitter} from 'node:events';

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
  private eventEmitter?: EventEmitter;
  private logger?: Logger;

  constructor(logger?: Logger, eventEmitter?: EventEmitter) {
    this.logger = logger;
    this.eventEmitter = eventEmitter;
  }

  public async install(deployable: SourceDeployable, targetOrg: string, options?: {testLevel?: string}): Promise<{deployId?: string}> {
    const {componentSet, packageName} = deployable;

    this.logger?.info(`Using source deployment strategy for package: ${packageName}`);
    this.logger?.info(`Deploying source to ${targetOrg}`);

    this.emitStart(packageName);

    const deployService = new MetadataDeployService(this.logger);

    const deployId = await deployService.deploy(componentSet, targetOrg, {
      testLevel: options?.testLevel as 'NoTestRun' | 'RunLocalTests' | 'RunSpecifiedTests' | undefined,
    });

    const result = await deployService.awaitDeploy(deployId, targetOrg, progress => {
      this.emitProgress(packageName, progress.status, progress.percentage);
    });

    if (!result.success) {
      const errorMessages = result.formatErrors() || 'Unknown deployment error';
      this.emitComplete(packageName, false);
      throw new Error(`Source deployment failed:\n${errorMessages}`);
    }

    this.emitComplete(packageName, true);
    this.logger?.info('Source deployment completed successfully');

    return {deployId};
  }

  private emitComplete(packageName: string, success: boolean): void {
    this.eventEmitter?.emit('deployment:complete', {
      packageName,
      success,
      timestamp: new Date(),
    });
  }

  private emitProgress(packageName: string, status: string, percentComplete: number): void {
    this.eventEmitter?.emit('deployment:progress', {
      packageName,
      percentComplete,
      status,
      timestamp: new Date(),
    });
  }

  private emitStart(packageName: string): void {
    this.eventEmitter?.emit('deployment:start', {
      packageName,
      timestamp: new Date(),
    });
  }
}
