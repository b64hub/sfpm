import {Org} from '@salesforce/core';
import {type DeploySetOptions} from '@salesforce/source-deploy-retrieve';
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

  public async install(deployable: SourceDeployable, targetOrg: string, options?: {testLevel?: string}): Promise<{deployId?: string}> {
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
    const deployOptions: DeploySetOptions = {
      usernameOrConnection: connection,
    };

    if (options?.testLevel) {
      deployOptions.apiOptions = {
        ...deployOptions.apiOptions,
        testLevel: options.testLevel as DeploySetOptions['apiOptions'] extends {testLevel?: infer T} ? T : never,
      };
    }

    const deploy = await componentSet.deploy(deployOptions);
    const deployId = deploy.id;

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

    try {
      // Wait for deployment to complete
      // SDR's pollStatus already handles transient connection errors
      // (ECONNRESET, ETIMEDOUT, socket hang up, etc.) with up to 1000 retries.
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
    } catch (error) {
      await this.handleDeployFailure(error, deployId, packageName, targetOrg);
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

  /**
   * Handle a failed deployment by checking server-side status.
   *
   * If SDR's polling exhausted its retry limit or the connection dropped
   * permanently, we reconnect and verify whether the deploy actually succeeded.
   *
   * Returns normally only when the deployment succeeded server-side.
   * Throws in all other cases.
   */
  private async handleDeployFailure(
    error: unknown,
    deployId: string | undefined,
    packageName: string,
    targetOrg: string,
  ): Promise<void> {
    if (!deployId) {
      throw error;
    }

    try {
      this.logger?.debug(`Deploy polling failed for ${packageName}, verifying server-side status (deploy ${deployId})...`);

      // Reconnect — the original connection may be dead
      const org = await Org.create({aliasOrUsername: targetOrg});
      const freshConnection = org.getConnection();
      const status = await freshConnection.metadata.checkDeployStatus(deployId, true);

      if (status.success) {
        this.logger?.info('Source deployment succeeded server-side despite client error');
        return;
      }

      if (status.done) {
        // Deployment finished but failed
        const failures = status.details?.componentFailures;
        const failuresArray = Array.isArray(failures) ? failures : failures ? [failures] : [];
        const errorMessages = failuresArray
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        .map((failure: any) => `${failure.fullName}: ${failure.problem}`)
        .join('\n') || 'Unknown deployment error';
        throw new Error(`Source deployment failed:\n${errorMessages}`, {cause: error});
      }

      // Still in progress
      const msg = [
        `Source deployment for ${packageName} was interrupted but is still in progress on the server.`,
        '',
        `  Deploy ID: ${deployId}`,
        `  Status: ${status.status}`,
        '',
        'Check status with:',
        `  sf project deploy report -i ${deployId} -o ${targetOrg}`,
      ].join('\n');

      this.logger?.error(msg);
      throw new Error(msg, {cause: error});
    } catch (verifyError) {
      if (verifyError instanceof Error && verifyError.cause === error) {
        throw verifyError;
      }

      this.logger?.debug(`Could not verify deploy status: ${verifyError instanceof Error ? verifyError.message : String(verifyError)}`);
      throw error;
    }
  }
}

