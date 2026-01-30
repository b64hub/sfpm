import EventEmitter from "node:events";
import { Logger } from "../types/logger.js";
import { PackageType, InstallationSourceType } from "../types/package.js";
import ProjectConfig from "../project/project-config.js";
import { Installer, InstallerRegistry } from "./installers/installer-registry.js";
import SfpmPackage, { PackageFactory, SfpmUnlockedPackage } from "./sfpm-package.js";
import { ArtifactService } from "../artifacts/artifact-service.js";

// Import installers to trigger registration
import "./installers/unlocked-package-installer.js";
import "./installers/source-package-installer.js";

export interface InstallOptions {
    targetOrg: string;
    installationKey?: string;
    sourceType?: InstallationSourceType;
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
     * Install a single package by name
     * @param packageName 
     * @param projectDirectory 
     */
    public async installPackage(
        packageName: string,
        projectDirectory: string = process.cwd()
    ): Promise<void> {
        // Use PackageFactory to create a fully-configured package
        const packageFactory = new PackageFactory(this.projectConfig);
        const sfpmPackage = packageFactory.createFromName(packageName);

        // Check for artifacts and update version if available
        // This ensures we show the actual built version instead of ".NEXT" when artifacts exist
        const artifactService = new ArtifactService(this.logger);
        const artifactInfo = artifactService.getLocalArtifactInfo(
            sfpmPackage.projectDirectory,
            sfpmPackage.packageName
        );

        if (artifactInfo.version) {
            sfpmPackage.version = artifactInfo.version;
            
            // For unlocked packages, also update package version ID if available from metadata
            if (sfpmPackage instanceof SfpmUnlockedPackage && artifactInfo.metadata) {
                const unlockedIdentity = artifactInfo.metadata.identity as any;
                if (unlockedIdentity?.packageVersionId) {
                    sfpmPackage.packageVersionId = unlockedIdentity.packageVersionId;
                }
            }
        }

        this.logger?.info(`Starting installation of package: ${sfpmPackage.packageName}`);

        // Emit install start event
        this.emit('install:start', {
            timestamp: new Date(),
            packageName: sfpmPackage.packageName,
            packageVersion: sfpmPackage.version,
            packageType: sfpmPackage.type as PackageType,
            targetOrg: this.options.targetOrg,
        });

        try {
            // Get installer for package type
            const InstallerConstructor = InstallerRegistry.getInstaller(sfpmPackage.type as any);
            
            if (!InstallerConstructor) {
                throw new Error(`No installer registered for package type: ${sfpmPackage.type}`);
            }

            // Create installer instance
            const installer = new InstallerConstructor(
                this.options.targetOrg,
                sfpmPackage,
                this.logger
            );

            // Connect to target org
            await installer.connect(this.options.targetOrg);

            // Execute installation
            await installer.exec();

            // Emit install complete event
            this.emit('install:complete', {
                timestamp: new Date(),
                packageName: sfpmPackage.packageName,
                packageVersion: sfpmPackage.version,
                packageType: sfpmPackage.type as PackageType,
                targetOrg: this.options.targetOrg,
                success: true,
            });

            this.logger?.info(`Successfully installed package: ${sfpmPackage.packageName}`);
        } catch (error) {
            // Emit install error event
            this.emit('install:error', {
                timestamp: new Date(),
                packageName: sfpmPackage.packageName,
                packageVersion: sfpmPackage.version,
                packageType: sfpmPackage.type as PackageType,
                targetOrg: this.options.targetOrg,
                error: error instanceof Error ? error.message : String(error),
            });

            this.logger?.error(`Failed to install package: ${sfpmPackage.packageName}. Error: ${error instanceof Error ? error.message : String(error)}`);
            
            // Re-throw with more context
            if (error instanceof Error) {
                const detailedError = new Error(`Failed to install package: ${sfpmPackage.packageName}. ${error.message}`);
                (detailedError as any).cause = error;
                throw detailedError;
            }
            throw error;
        }
    }
}