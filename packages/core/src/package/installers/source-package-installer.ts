import path from 'path';
import fs from 'fs-extra';
import EventEmitter from 'node:events';

import { Org } from '@salesforce/core';
import { Installer, RegisterInstaller } from './installer-registry.js';
import { PackageType, InstallationSource } from '../../types/package.js';
import SfpmPackage, { SfpmSourcePackage } from '../sfpm-package.js';
import { Logger } from '../../types/logger.js';
import { InstallationStrategy } from './installation-strategy.js';
import { ArtifactService } from '../../artifacts/artifact-service.js';

// Import strategies
import SourceDeployStrategy from './strategies/source-deploy-strategy.js';

export interface SourcePackageInstallerOptions {
    /** Where the code comes from: 'local' (project source) or 'artifact' */
    source?: InstallationSource;
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
    private source: InstallationSource;
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

        // Determine source
        this.source = this.determineSource(options);
    }

    private determineSource(options?: SourcePackageInstallerOptions): InstallationSource {
        if (options?.source) {
            return options.source;
        }

        // Auto-detect: if artifacts exist, use artifact; otherwise local
        const repo = this.artifactService.getRepository(this.sfpmPackage.projectDirectory);
        if (repo.hasArtifacts(this.sfpmPackage.packageName)) {
            return InstallationSource.Artifact;
        }

        return InstallationSource.Local;
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
            s.canHandle(this.source, this.sfpmPackage)
        );

        if (!strategy) {
            throw new Error(
                `No installation strategy found for source: ${this.source}, package: ${this.sfpmPackage.packageName}`
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
