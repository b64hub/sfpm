import EventEmitter from "node:events";
import { Logger } from "../types/logger.js";
import { PackageType, InstallationSourceType } from "../types/package.js";
import ProjectConfig from "../project/project-config.js";
import { Installer, InstallerRegistry } from "./installers/installer-registry.js";
import SfpmPackage, { PackageFactory } from "./sfpm-package.js";

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

        this.logger?.info(`Starting installation of package: ${sfpmPackage.packageName}`);

        // Emit install start event
        this.emit('install:start', {
            timestamp: new Date(),
            packageName: sfpmPackage.packageName,
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
                packageType: sfpmPackage.type as PackageType,
                targetOrg: this.options.targetOrg,
                error: error instanceof Error ? error.message : String(error),
            });

            this.logger?.error(`Failed to install package: ${sfpmPackage.packageName}`);
            throw error;
        }
    }
}