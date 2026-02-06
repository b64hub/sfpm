import { SfProject } from '@salesforce/core';
import ProjectConfig from './project-config.js';
import { ProjectGraph } from './project-graph.js';
import { VersionManager } from './version-manager.js';
import { ProjectDefinition, PackageDefinition } from '../types/project.js';
import { PackageType } from '../types/package.js';

export default class ProjectService {
    private static instance: ProjectService | undefined;

    private readonly versionManager: VersionManager;
    private readonly projectConfig: ProjectConfig;

    private constructor(projectConfig: ProjectConfig, versionManager: VersionManager) {
        this.projectConfig = projectConfig;
        this.versionManager = versionManager;
    }

    /**
     * Creates and initializes a new ProjectService instance from a directory path.
     * This is the recommended way to create a ProjectService.
     * 
     * @param projectPath - Path to project directory (defaults to current working directory)
     * @returns Fully initialized ProjectService instance
     */
    public static async create(projectPath?: string): Promise<ProjectService> {
        const sfProject = await SfProject.resolve(projectPath);
        const projectConfig = new ProjectConfig(sfProject);
        const versionManager = VersionManager.create(projectConfig);

        return new ProjectService(projectConfig, versionManager);
    }

    /**
     * Creates and initializes a new ProjectService instance from an existing SfProject.
     * 
     * @param project - SfProject instance
     * @returns Fully initialized ProjectService instance
     */
    public static createFromProject(project: SfProject): ProjectService {
        const projectConfig = new ProjectConfig(project);
        const versionManager = VersionManager.create(projectConfig);

        return new ProjectService(projectConfig, versionManager);
    }

    /**
     * Gets or creates the singleton ProjectService instance.
     * Note: First call must be awaited to ensure initialization.
     * 
     * @param projectPath - Path to project directory (defaults to current working directory)
     * @returns Promise resolving to the singleton instance
     */
    public static async getInstance(projectPath?: string): Promise<ProjectService> {
        if (!ProjectService.instance) {
            ProjectService.instance = await ProjectService.create(projectPath);
        }
        return ProjectService.instance;
    }

    /**
     * Resets the singleton instance (useful for testing)
     */
    public static resetInstance(): void {
        ProjectService.instance = undefined;
    }

    public getVersionManager(): VersionManager {
        return this.versionManager;
    }

    public getProjectGraph(): ProjectGraph {
        return this.versionManager.getGraph();
    }

    /**
     * Returns the ProjectConfig instance managed by this service
     */
    public getProjectConfig(): ProjectConfig {
        return this.projectConfig;
    }

    /**
     * Static helper to get the project definition
     */
    public static async getProjectDefinition(workingDirectory?: string): Promise<ProjectDefinition> {
        const service = await ProjectService.getInstance(workingDirectory);
        return service.getProjectConfig().getProjectDefinition();
    }

    /**
     * Static helper to get a specific package definition
     */
    public static async getPackageDefinition(packageName: string, workingDirectory?: string): Promise<PackageDefinition> {
        const service = await ProjectService.getInstance(workingDirectory);
        return service.getProjectConfig().getPackageDefinition(packageName);
    }

    /**
     * Static helper to get all transitive dependencies of a package
     */
    public static async getPackageDependencies(packageName: string, workingDirectory?: string): Promise<PackageDefinition[]> {
        const service = await ProjectService.getInstance(workingDirectory);
        return service.getProjectGraph().getTransitiveDependencies(packageName);
    }

    /**
     * Static helper to get package type
     */
    public static async getPackageType(packageName: string, workingDirectory?: string): Promise<PackageType> {
        const service = await ProjectService.getInstance(workingDirectory);
        return service.getProjectConfig().getPackageType(packageName);
    }
}