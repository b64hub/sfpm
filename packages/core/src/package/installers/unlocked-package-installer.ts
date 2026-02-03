
import EventEmitter from 'node:events';
import { Org } from '@salesforce/core';
import { Installer, RegisterInstaller } from './installer-registry.js';
import { PackageType, InstallationSource, InstallationMode } from '../../types/package.js';
import SfpmPackage, { SfpmUnlockedPackage } from '../sfpm-package.js';
import { Logger } from '../../types/logger.js';
import { InstallationStrategy } from './installation-strategy.js';
import { ArtifactService } from '../../artifacts/artifact-service.js';

// Import strategies
import SourceDeployStrategy from './strategies/source-deploy-strategy.js';
import UnlockedVersionInstallStrategy from './strategies/unlocked-version-install-strategy.js';

export interface UnlockedPackageInstallerOptions {
    installationKey?: string;
    /** Where the code comes from: 'local' (project source) or 'artifact' */
    source?: InstallationSource;
    /** Specify installation mode (overrides auto-detection) */
    mode?: InstallationMode;
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
    private source: InstallationSource;
    private mode?: InstallationMode;
    private artifactService: ArtifactService;

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
        this.mode = options?.mode;

        // Initialize artifact service
        this.artifactService = new ArtifactService(logger);

        // Initialize strategies (order matters: version install first, source deploy as fallback)
        this.strategies = [
            new UnlockedVersionInstallStrategy(logger, this),
            new SourceDeployStrategy(logger, this),
        ];

        // Determine source
        this.source = this.determineSource(options);
    }

    private determineSource(options?: UnlockedPackageInstallerOptions): InstallationSource {
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
        this.logger?.info(`Installing unlocked package: ${this.sfpmPackage.packageName}`);

        await this.runPreInstallTasks();
        await this.installPackage();
        await this.runPostInstallTasks();
    }

    private async installPackage(): Promise<void> {
        // Find appropriate strategy
        let strategy: InstallationStrategy | undefined;

        // If mode is explicitly set, find strategy with matching mode
        if (this.mode) {
            strategy = this.strategies.find(s => s.getMode() === this.mode);
            if (!strategy) {
                throw new Error(`No strategy found for mode: ${this.mode}`);
            }
        } else {
            // Auto-select based on source and package state
            strategy = this.strategies.find(s => s.canHandle(this.source, this.sfpmPackage));
        }

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
