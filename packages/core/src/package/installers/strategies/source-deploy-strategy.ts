import { Org } from '@salesforce/core';
import { ComponentSet } from '@salesforce/source-deploy-retrieve';
import { EventEmitter } from 'node:events';
import { InstallationStrategy } from '../installation-strategy.js';
import { InstallationSourceType, InstallationMode } from '../../../types/package.js';
import SfpmPackage, { SfpmUnlockedPackage, SfpmSourcePackage } from '../../sfpm-package.js';
import { Logger } from '../../../types/logger.js';

/**
 * Unified strategy for deploying packages via source deployment
 * Handles both unlocked packages (from local source) and source packages (from any source type)
 */
export default class SourceDeployStrategy implements InstallationStrategy {
    private logger?: Logger;
    private eventEmitter?: EventEmitter;

    constructor(logger?: Logger, eventEmitter?: EventEmitter) {
        this.logger = logger;
        this.eventEmitter = eventEmitter;
    }

    public canHandle(sourceType: InstallationSourceType, sfpmPackage: SfpmPackage): boolean {
        // Source packages always use source deployment
        if (sfpmPackage instanceof SfpmSourcePackage) {
            return true;
        }

        // Unlocked packages use source deployment when installing from local source
        if (sfpmPackage instanceof SfpmUnlockedPackage && sourceType === InstallationSourceType.LocalSource) {
            return true;
        }

        return false;
    }

    public getMode(): InstallationMode {
        return InstallationMode.SourceDeploy;
    }

    public async install(sfpmPackage: SfpmPackage, targetOrg: string): Promise<void> {
        this.logger?.info(`Using source deployment strategy for package: ${sfpmPackage.packageName}`);

        // Get source path from package directory
        const sourcePath = sfpmPackage.packageDirectory;
        
        if (!sourcePath) {
            throw new Error(`Unable to determine source path for package: ${sfpmPackage.packageName}`);
        }

        this.logger?.info(`Deploying source from ${sourcePath} to ${targetOrg}`);

        // Connect to target org
        const org = await Org.create({ aliasOrUsername: targetOrg });
        const connection = org.getConnection();

        if (!connection) {
            throw new Error(`Unable to connect to org: ${targetOrg}`);
        }

        // Create component set from source path
        const componentSet = ComponentSet.fromSource(sourcePath);
        const componentCount = componentSet.size;

        // Emit deployment start event
        this.eventEmitter?.emit('deployment:start', {
            timestamp: new Date(),
            packageName: sfpmPackage.packageName,
            sourcePath,
            componentCount,
        });

        // Deploy to org
        const deploy = await componentSet.deploy({
            usernameOrConnection: connection,
        });

        // Track deployment progress
        deploy.onUpdate((response) => {
            const status = response.status;
            const numberComponentsDeployed = response.numberComponentsDeployed || 0;
            const numberComponentsTotal = response.numberComponentsTotal || componentCount;
            const percentComplete = numberComponentsTotal > 0 
                ? Math.round((numberComponentsDeployed / numberComponentsTotal) * 100)
                : 0;

            this.eventEmitter?.emit('deployment:progress', {
                timestamp: new Date(),
                packageName: sfpmPackage.packageName,
                status,
                componentsDeployed: numberComponentsDeployed,
                componentsTotal: numberComponentsTotal,
                percentComplete,
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
            timestamp: new Date(),
            packageName: sfpmPackage.packageName,
            success: true,
            componentsDeployed: result.response.numberComponentsDeployed || 0,
        });

        this.logger?.info(`Source deployment completed successfully`);
    }
}
