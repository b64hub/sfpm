import EventEmitter from 'node:events';
import { Org } from '@salesforce/core';
import { Logger } from '../types/logger.js';
import { PackageType, InstallationSource, InstallationMode } from '../types/package.js';
import ProjectConfig from '../project/project-config.js';
import { InstallerRegistry } from './installers/installer-registry.js';
import SfpmPackage, { PackageFactory, SfpmUnlockedPackage } from './sfpm-package.js';
import { ArtifactService, InstallTarget } from '../artifacts/artifact-service.js';

// Import installers to trigger registration
import './installers/unlocked-package-installer.js';
import './installers/source-package-installer.js';

export interface InstallOptions {
    targetOrg: string;
    installationKey?: string;
    /** 
     * Where to install from: 'local' (project source) or 'artifact'.
     */
    source?: InstallationSource;
    /**
     * Set specific installation mode (mainly for unlocked packages, overrides auto-detection).
     */
    mode?: InstallationMode;
    /** Force reinstall even if already installed with matching version/hash */
    force?: boolean;
    /** Force refresh from npm registry (bypass TTL cache) */
    forceRefresh?: boolean;
    /** Only use local artifacts, don't check npm registry */
    localOnly?: boolean;
}

export interface InstallResult {
    packageName: string;
    version: string;
    installed: boolean;
    skipped: boolean;
    skipReason?: string;
}

export interface InstallTask {
    exec(): Promise<void>;
}

/**
 * Orchestrator for package installations
 */
export default class PackageInstaller extends EventEmitter {
    private options: InstallOptions;
    private logger: Logger | undefined;
    private projectConfig: ProjectConfig;
    private org?: Org;

    constructor(projectConfig: ProjectConfig, options: InstallOptions, logger?: Logger) {
        super();
        this.options = options;
        this.logger = logger;
        this.projectConfig = projectConfig;
    }

    /**
     * Install a package and its dependencies in the project
     */
    public async install(): Promise<void> {
        // TODO: Implement dependency resolution and installation
    }

    /**
     * Install a single package by name.
     * 
     * This method:
     * 1. Resolves the best artifact version (local or from npm)
     * 2. Checks if installation is needed based on org status
     * 3. Installs using the appropriate installer for the package type
     * 
     * @param packageName - Name of the package to install
     * @returns InstallResult with details of what happened
     */
    public async installPackage(packageName: string): Promise<InstallResult> {
        // Create base package from project config
        const sfpmPackage = new PackageFactory(this.projectConfig).createFromName(packageName);

        // Ensure we have an org connection
        if (!this.org) {
            this.org = await Org.create({ aliasOrUsername: this.options.targetOrg });
        }

        // Create artifact service with org for install target resolution
        const artifactService = new ArtifactService(this.logger, this.org);

        // Resolve install target (combines artifact resolution + org status check)
        const installTarget = await artifactService.resolveInstallTarget(
            sfpmPackage.projectDirectory,
            sfpmPackage.packageName,
            {
                forceRefresh: this.options.forceRefresh,
                localOnly: this.options.localOnly,
            }
        );

        // Update package with resolved artifact info
        this.updatePackageFromTarget(sfpmPackage, installTarget);

        // Check if we should skip installation (default: skip if already installed, unless force is set)
        if (!this.options.force && !installTarget.needsInstall) {
            this.logger?.info(
                `Skipping ${packageName}@${installTarget.resolved.version}: ${installTarget.installReason}`
            );
            this.emitSkip(sfpmPackage, installTarget.installReason);
            
            return {
                packageName,
                version: installTarget.resolved.version,
                installed: false,
                skipped: true,
                skipReason: installTarget.installReason,
            };
        }

        // Log install decision
        this.logger?.info(
            `Installing ${packageName}@${installTarget.resolved.version} ` +
            `(reason: ${installTarget.installReason}, source: ${installTarget.resolved.source})`
        );
        this.emitStart(sfpmPackage, installTarget);

        try {
            // Get installer for package type
            const InstallerConstructor = InstallerRegistry.getInstaller(sfpmPackage.type as any);
            if (!InstallerConstructor) {
                throw new Error(`No installer registered for package type: ${sfpmPackage.type}`);
            }

            // Create and execute installer
            const installer = new InstallerConstructor(this.options.targetOrg, sfpmPackage, this.logger);
            await installer.connect(this.options.targetOrg);
            await installer.exec();

            // Update artifact record in org
            await artifactService.upsertArtifact(sfpmPackage);

            this.emitComplete(sfpmPackage, installTarget);
            this.logger?.info(`Successfully installed ${packageName}@${sfpmPackage.version}`);

            return {
                packageName,
                version: installTarget.resolved.version,
                installed: true,
                skipped: false,
            };
        } catch (error) {
            this.emitError(sfpmPackage, error as Error);
            this.logger?.error(
                `Failed to install ${packageName}: ${error instanceof Error ? error.message : String(error)}`
            );
            throw error;
        }
    }

    /**
     * Update the SfpmPackage instance with information from the resolved install target.
     */
    private updatePackageFromTarget(sfpmPackage: SfpmPackage, installTarget: InstallTarget): void {
        const { resolved } = installTarget;

        // Set version from resolved artifact
        sfpmPackage.version = resolved.version;
        sfpmPackage.sourceHash = resolved.versionEntry.sourceHash;

        // For unlocked packages, set the packageVersionId
        if (sfpmPackage instanceof SfpmUnlockedPackage && resolved.packageVersionId) {
            sfpmPackage.packageVersionId = resolved.packageVersionId;
        }
    }

    private emitStart(sfpmPackage: SfpmPackage, installTarget: InstallTarget): void {
        this.emit('install:start', {
            timestamp: new Date(),
            packageName: sfpmPackage.packageName,
            packageVersion: sfpmPackage.version,
            packageType: sfpmPackage.type as PackageType,
            targetOrg: this.options.targetOrg,
            source: installTarget.resolved.source,
            installReason: installTarget.installReason,
        });
    }

    private emitSkip(sfpmPackage: SfpmPackage, reason: string): void {
        this.emit('install:skip', {
            timestamp: new Date(),
            packageName: sfpmPackage.packageName,
            packageVersion: sfpmPackage.version,
            packageType: sfpmPackage.type as PackageType,
            targetOrg: this.options.targetOrg,
            reason,
        });
    }

    private emitComplete(sfpmPackage: SfpmPackage, installTarget: InstallTarget): void {
        this.emit('install:complete', {
            timestamp: new Date(),
            packageName: sfpmPackage.packageName,
            packageVersion: sfpmPackage.version,
            packageType: sfpmPackage.type as PackageType,
            targetOrg: this.options.targetOrg,
            source: installTarget.resolved.source,
            success: true,
        });
    }

    private emitError(sfpmPackage: SfpmPackage, error: Error): void {
        this.emit('install:error', {
            timestamp: new Date(),
            packageName: sfpmPackage.packageName,
            packageVersion: sfpmPackage.version,
            packageType: sfpmPackage.type as PackageType,
            targetOrg: this.options.targetOrg,
            error: error instanceof Error ? error.message : String(error),
        });
    }
}
