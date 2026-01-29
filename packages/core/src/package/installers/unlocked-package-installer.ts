import path from 'path';
import fs from 'fs-extra';
import EventEmitter from 'node:events';

import { Org } from '@salesforce/core';
import { Installer, RegisterInstaller } from './installer-registry.js';
import { PackageType, InstallationSourceType } from '../../types/package.js';
import SfpmPackage, { SfpmUnlockedPackage } from '../sfpm-package.js';
import { Logger } from '../../types/logger.js';
import { InstallationStrategy } from './installation-strategy.js';

// Import strategies
import SourceDeployStrategy from './strategies/source-deploy-strategy.js';
import UnlockedVersionInstallStrategy from './strategies/unlocked-version-install-strategy.js';

export interface UnlockedPackageInstallerOptions {
    installationKey?: string;
    sourceType?: InstallationSourceType;
}

export interface InstallTask {
    exec(): Promise<void>;
}

@RegisterInstaller(PackageType.Unlocked)
export default class UnlockedPackageInstaller extends EventEmitter implements Installer {
    private targetOrg: string;
    private sfpmPackage: SfpmUnlockedPackage;
    private logger?: Logger;
    private org?: Org;
    private strategies: InstallationStrategy[];
    private sourceType: InstallationSourceType;

    public preInstallTasks: InstallTask[] = [];
    public postInstallTasks: InstallTask[] = [];

    constructor(targetOrg: string, sfpmPackage: SfpmPackage, logger?: Logger, options?: UnlockedPackageInstallerOptions) {
        super();
        if (!(sfpmPackage instanceof SfpmUnlockedPackage)) {
            throw new Error(
                `UnlockedPackageInstaller received incompatible package type: ${sfpmPackage.constructor.name}`
            );
        }
        this.targetOrg = targetOrg;
        this.sfpmPackage = sfpmPackage;
        this.logger = logger;

        // Initialize strategies (pass this as event emitter)
        this.strategies = [
            new UnlockedVersionInstallStrategy(logger, this),
            new SourceDeployStrategy(logger, this),
        ];

        // Determine source type
        this.sourceType = this.determineSourceType(options);
    }

    private determineSourceType(options?: UnlockedPackageInstallerOptions): InstallationSourceType {
        if (options?.sourceType) {
            return options.sourceType;
        }

        // Auto-detect source type
        const artifactPath = path.join(
            this.sfpmPackage.projectDirectory,
            'artifacts',
            this.sfpmPackage.packageName
        );

        if (fs.existsSync(artifactPath)) {
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
        this.logger?.info(`Installing unlocked package: ${this.sfpmPackage.packageName}`);

        await this.runPreInstallTasks();
        await this.installPackage();
        await this.runPostInstallTasks();
    }

    private async installPackage(): Promise<void> {
        // Find appropriate strategy
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
