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

  public async install(deployable: SourceDeployable, targetOrg: string): Promise<void> {
    const {componentSet, packageName} = deployable;

    this.logger?.info(`Using source deployment strategy for package: ${packageName}`);
    this.logger?.info(`Deploying source to ${targetOrg}`);

    // Connect to target org
    const org = await Org.create({aliasOrUsername: targetOrg});
    const connection = org.getConnection();

    if (!connection) {
      throw new Error(`Unable to connect to org: ${targetOrg}`);
    }

    // Use the componentSet from the SourceDeployable
    const componentCount = componentSet.size;

    // Emit deployment start event
    this.eventEmitter?.emit('deployment:start', {
      componentCount,
      packageName,
      timestamp: new Date(),
    });

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

      this.eventEmitter?.emit('deployment:progress', {
        componentsDeployed: numberComponentsDeployed,
        componentsTotal: numberComponentsTotal,
        packageName,
        percentComplete,
        status,
        timestamp: new Date(),
      });
    });

    // Wait for deployment to complete
    const result = await deploy.pollStatus();

    if (!result.response.success) {
      const failures = result.response.details?.componentFailures;
      const failuresArray = Array.isArray(failures) ? failures : failures ? [failures] : [];
      const errorMessages = failuresArray
      .map((failure: any) => `${failure.fullName}: ${failure.problem}`)
      .join('\n') || 'Unknown deployment error';

      throw new Error(`Source deployment failed:\n${errorMessages}`);
    }

    // Emit deployment complete event
    this.eventEmitter?.emit('deployment:complete', {
      componentsDeployed: result.response.numberComponentsDeployed || 0,
      packageName,
      success: true,
      timestamp: new Date(),
    });

    this.logger?.info('Source deployment completed successfully');
  }
}
