import path from 'path';
import fs from 'fs-extra';
import { Org, Connection } from '@salesforce/core';
import { EventEmitter } from 'node:events';
import { InstallationStrategy } from '../installation-strategy.js';
import { InstallationSourceType, InstallationMode, SfpmUnlockedPackageBuildOptions } from '../../../types/package.js';
import SfpmPackage, { SfpmUnlockedPackage } from '../../sfpm-package.js';
import { Logger } from '../../../types/logger.js';

type PackageInstallRequest = {
    Id: string;
    Status: string;
    SubscriberPackageVersionKey: string;
    Errors?: { errors: Array<{ message: string }> };
};

/**
 * Strategy for installing unlocked package by version ID from built artifact
 */
export default class UnlockedVersionInstallStrategy implements InstallationStrategy {
    private logger?: Logger;
    private eventEmitter?: EventEmitter;

    constructor(logger?: Logger, eventEmitter?: EventEmitter) {
        this.logger = logger;
        this.eventEmitter = eventEmitter;
    }

    public canHandle(sourceType: InstallationSourceType, sfpmPackage: SfpmPackage): boolean {
        if (!(sfpmPackage instanceof SfpmUnlockedPackage)) {
            return false;
        }

        // Can handle built artifacts or remote NPM if version ID is available
        const hasVersionId = !!sfpmPackage.packageVersionId;
        const isValidSourceType = 
            sourceType === InstallationSourceType.BuiltArtifact || 
            sourceType === InstallationSourceType.RemoteNpm;

        return hasVersionId && isValidSourceType;
    }

    public getMode(): InstallationMode {
        return InstallationMode.VersionInstall;
    }

    public async install(sfpmPackage: SfpmPackage, targetOrg: string): Promise<void> {
        if (!(sfpmPackage instanceof SfpmUnlockedPackage)) {
            throw new Error(`UnlockedVersionInstallStrategy requires SfpmUnlockedPackage`);
        }

        this.logger?.info(`Using version install strategy for unlocked package: ${sfpmPackage.packageName}`);

        const versionId = sfpmPackage.packageVersionId;
        if (!versionId) {
            throw new Error(`Package version ID not found for: ${sfpmPackage.packageName}`);
        }

        // Get installation key from package metadata if available
        const buildOptions = sfpmPackage.metadata?.orchestration?.buildOptions as SfpmUnlockedPackageBuildOptions | undefined;
        const installationKey = buildOptions?.installationkey;

        this.logger?.info(`Installing package version ${versionId} to ${targetOrg}`);

        // Connect to target org
        const org = await Org.create({ aliasOrUsername: targetOrg });
        const connection = org.getConnection();

        if (!connection) {
            throw new Error(`Unable to connect to org: ${targetOrg}`);
        }

        // Create package install request using Tooling API
        this.logger?.info(`Starting package installation...`);
        
        // Emit version-install start event
        this.eventEmitter?.emit('version-install:start', {
            timestamp: new Date(),
            packageName: sfpmPackage.packageName,
            versionId,
        });

        const installRequest = {
            SubscriberPackageVersionKey: versionId,
            Password: installationKey || '',
            ApexCompileType: 'package',
        };

        const result = await connection.tooling.create('PackageInstallRequest', installRequest);
        
        if (!result.success || !result.id) {
            throw new Error(`Failed to create package install request: ${JSON.stringify(result.errors || [])}`);
        }

        const requestId = result.id as string;

        // Poll for installation status
        const installStatus = await this.pollInstallStatus(connection, requestId, sfpmPackage.packageName);

        if (installStatus.Status !== 'SUCCESS') {
            const errors = installStatus.Errors?.errors?.map((e) => e.message).join('\n') || 'Unknown installation error';
            throw new Error(`Package installation failed:\n${errors}`);
        }

        // Emit version-install complete event
        this.eventEmitter?.emit('version-install:complete', {
            timestamp: new Date(),
            packageName: sfpmPackage.packageName,
            success: true,
        });

        this.logger?.info(`Package installation completed successfully`);
    }

    private async pollInstallStatus(connection: Connection, requestId: string, packageName: string): Promise<PackageInstallRequest> {
        const maxAttempts = 120; // 10 minutes with 5 second intervals
        let attempts = 0;

        while (attempts < maxAttempts) {
            const record = await connection.tooling.retrieve('PackageInstallRequest', requestId);
            
            if (!record) {
                throw new Error(`Could not retrieve PackageInstallRequest: ${requestId}`);
            }

            const status = (record as any).Status;
            this.logger?.info(`Installation status: ${status}`);

            // Emit progress event
            this.eventEmitter?.emit('version-install:progress', {
                timestamp: new Date(),
                packageName,
                status,
                attempt: attempts + 1,
                maxAttempts,
            });

            if (status === 'SUCCESS' || status === 'ERROR') {
                return record as PackageInstallRequest;
            }

            // Wait 5 seconds before next poll
            await new Promise(resolve => setTimeout(resolve, 5000));
            attempts++;
        }

        throw new Error(`Package installation timed out after ${maxAttempts * 5} seconds`);
    }
}
