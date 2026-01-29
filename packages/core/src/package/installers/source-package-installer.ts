import path from 'path';
import fs from 'fs-extra';
import EventEmitter from 'node:events';

import { Org } from '@salesforce/core';
import { Installer, RegisterInstaller } from './installer-registry.js';
import { PackageType, InstallationSourceType } from '../../types/package.js';
import SfpmPackage, { SfpmSourcePackage } from '../sfpm-package.js';
import { Logger } from '../../types/logger.js';
import { InstallationStrategy } from './installation-strategy.js';
import { ArtifactService } from '../../artifacts/artifact-service.js';

// Import strategies
import SourceDeployStrategy from './strategies/source-deploy-strategy.js';

export interface SourcePackageInstallerOptions {
    sourceType?: InstallationSourceType;
}

export interface InstallTask {
    exec(): Promise<void>;
}

@RegisterInstaller(PackageType.Source)
export default class SourcePackageInstaller extends EventEmitter implements Installer {
    private targetOrg: string;
    private sfpmPackage: SfpmSourcePackage;
    private logger?: Logger;
    private org?: Org;
    private strategies: InstallationStrategy[];
    private sourceType: InstallationSourceType;
    private artifactService: ArtifactService;

    public preInstallTasks: InstallTask[] = [];
    public postInstallTasks: InstallTask[] = [];

    constructor(targetOrg: string, sfpmPackage: SfpmPackage, logger?: Logger, options?: SourcePackageInstallerOptions) {
        super();
        if (!(sfpmPackage instanceof SfpmSourcePackage)) {
            throw new Error(
                `SourcePackageInstaller received incompatible package type: ${sfpmPackage.constructor.name}`
            );
        }
        this.targetOrg = targetOrg;
        this.sfpmPackage = sfpmPackage;
        this.logger = logger;

        // Initialize artifact service
        this.artifactService = new ArtifactService(logger);

        // Initialize strategies - source packages only use source deployment (pass this as event emitter)
        this.strategies = [
            new SourceDeployStrategy(logger, this),
        ];

        // Determine source type
        this.sourceType = this.determineSourceType(options);
    }

    private determineSourceType(options?: SourcePackageInstallerOptions): InstallationSourceType {
        if (options?.sourceType) {
            return options.sourceType;
        }

        // Auto-detect source type using ArtifactService
        if (this.artifactService.hasLocalArtifacts(this.sfpmPackage.projectDirectory, this.sfpmPackage.packageName)) {
            return InstallationSourceType.BuiltArtifact;
        }

        // Check if it's from npm (this would need more sophisticated detection)
        // For now, default to local source
        return InstallationSourceType.LocalSource;
    }

    public async connect(username: string): Promise<void> {
        this.emit('connection:start', {
            timestamp: new Date(),
            targetOrg: username,
        });

        this.org = await Org.create({ aliasOrUsername: username });
        
        if (!this.org.getConnection()) {
            throw new Error('Unable to connect to org');
        }

        this.emit('connection:complete', {
            timestamp: new Date(),
            targetOrg: username,
        });
    }

    public async exec(): Promise<void> {
        this.logger?.info(`Installing source package: ${this.sfpmPackage.packageName}`);

        await this.runPreInstallTasks();
        await this.installPackage();
        await this.runPostInstallTasks();
    }

    private async installPackage(): Promise<void> {
        // Find appropriate strategy (for source packages, there's only one)
        const strategy = this.strategies.find(s => 
            s.canHandle(this.sourceType, this.sfpmPackage)
        );

        if (!strategy) {
            throw new Error(
                `No installation strategy found for source type: ${this.sourceType}, package: ${this.sfpmPackage.packageName}`
            );
        }

        this.logger?.info(`Using installation mode: ${strategy.getMode()}`);

        // Execute installation using selected strategy
        await strategy.install(this.sfpmPackage, this.targetOrg);
    }

    private async runPreInstallTasks(): Promise<void> {
        for (const task of this.preInstallTasks) {
            const taskName = task.constructor.name;
            this.logger?.info(`Running pre-install task: ${taskName}`);
            await task.exec();
        }
    }

    private async runPostInstallTasks(): Promise<void> {
        for (const task of this.postInstallTasks) {
            const taskName = task.constructor.name;
            this.logger?.info(`Running post-install task: ${taskName}`);
            await task.exec();
        }
    }
}
