import {Org} from '@salesforce/core';
import {EventEmitter} from 'node:events';

import {Logger} from '../../../types/logger.js';
import {type SourceDeployable} from '../types.js';

/**
 * Deploys a package's source via the Metadata API.
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

  public async install(deployable: SourceDeployable, targetOrg: string): Promise<{deployId?: string}> {
    const {componentSet, packageName} = deployable;

    this.logger?.info(`Using source deployment strategy for package: ${packageName}`);
    this.logger?.info(`Deploying source to ${targetOrg}`);

    // Connect to target org
    const org = await Org.create({aliasOrUsername: targetOrg});
    const connection = org.getConnection();

    if (!connection) {
      throw new Error(`Unable to connect to org: ${targetOrg}`);
    }

    const componentCount = componentSet.size;
    this.emitStart(packageName);

    // Deploy to org
    const deploy = await componentSet.deploy({
      usernameOrConnection: connection,
    });

    // Track deployment progress
    deploy.onUpdate(response => {
      const {status} = response;
      const numberComponentsDeployed = response.numberComponentsDeployed || 0;
      const numberComponentsTotal = response.numberComponentsTotal || componentCount;
      const percentComplete = numberComponentsTotal > 0
        ? Math.round((numberComponentsDeployed / numberComponentsTotal) * 100)
        : 0;

      this.emitProgress(packageName, status, percentComplete);
    });

    // Wait for deployment to complete
    const result = await deploy.pollStatus();

    if (!result.response.success) {
      const failures = result.response.details?.componentFailures;
      const failuresArray = Array.isArray(failures) ? failures : failures ? [failures] : [];
      const errorMessages = failuresArray
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- DeployMessage shape varies across SDR versions
      .map((failure: any) => `${failure.fullName}: ${failure.problem}`)
      .join('\n') || 'Unknown deployment error';

      throw new Error(`Source deployment failed:\n${errorMessages}`);
    }

    const deployId = result.response.id;

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

