import { SfProject } from '@salesforce/core';
import ProjectConfig from './project-config.js';
import { ProjectGraph } from './project-graph.js';
import { VersionManager, VersionManagerConfig } from './version-manager.js';
import { ProjectDefinition, PackageDefinition } from '../types/project.js';
import { PackageType } from '../types/package.js';
import path from 'node:path';

export default class ProjectService {
    private static instance: ProjectService | undefined;

    private readonly versionManager: VersionManager;
    private readonly projectConfig: ProjectConfig;

    private constructor(projectConfig: ProjectConfig, versionManager: VersionManager) {
        this.projectConfig = projectConfig;
        this.versionManager = versionManager;
    }

    /**
     * Creates and initializes a new ProjectService instance.
     * This is the recommended way to create a ProjectService.
     * 
     * @param projectOrPath - SfProject instance or path to project directory
     * @returns Fully initialized ProjectService instance
     */
    public static async create(projectOrPath: SfProject | string = process.cwd()): Promise<ProjectService> {
        let sfProject: SfProject;
        if (projectOrPath instanceof SfProject) {
            sfProject = projectOrPath;
        } else {
            sfProject = await SfProject.resolve(projectOrPath);
        }

        const projectConfig = new ProjectConfig(sfProject);
        const versionManager = new VersionManager({ projectConfig });
        await versionManager.load();

        return new ProjectService(projectConfig, versionManager);
    }

    /**
     * Gets or creates the singleton ProjectService instance.
     * Note: First call must be awaited to ensure initialization.
     * 
     * @param projectOrPath - SfProject instance or path to project directory
     * @returns Promise resolving to the singleton instance
     */
    public static async getInstance(projectOrPath: SfProject | string = process.cwd()): Promise<ProjectService> {
        if (!ProjectService.instance) {
            ProjectService.instance = await ProjectService.create(projectOrPath);
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

    public getProjectGraph(): ProjectGraph | undefined {
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
        const graph = service.getProjectGraph();
        if (!graph) {
            throw new Error('Project graph not available');
        }
        return graph.getTransitiveDependencies(packageName);
    }

    /**
     * Static helper to get package type
     */
    public static async getPackageType(packageName: string, workingDirectory?: string): Promise<PackageType> {
        const service = await ProjectService.getInstance(workingDirectory);
        return service.getProjectConfig().getPackageType(packageName);
    }
}