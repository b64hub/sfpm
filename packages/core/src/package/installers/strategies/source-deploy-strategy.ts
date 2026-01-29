import { Org } from '@salesforce/core';
import { ComponentSet } from '@salesforce/source-deploy-retrieve';
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

    constructor(logger?: Logger) {
        this.logger = logger;
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

        // Deploy to org
        const deploy = await componentSet.deploy({
            usernameOrConnection: connection,
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

        this.logger?.info(`Source deployment completed successfully`);
    }
}
