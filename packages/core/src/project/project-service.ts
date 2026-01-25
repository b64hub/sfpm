import { SfProject } from '@salesforce/core';
import ProjectConfig from './project-config.js';
import { ProjectGraph } from './project-graph.js';
import { VersionManager, VersionManagerConfig } from './version-manager.js';
import { ProjectDefinition, PackageDefinition } from '../types/project.js';
import { PackageType } from '../types/package.js';

export default class ProjectService {
    private static instance: ProjectService | undefined;
    private initialized = false;

    private versionManager!: VersionManager;
    private projectConfig!: ProjectConfig;

    constructor(private projectOrPath?: SfProject | string) {
    }

    /**
     * Gets or creates the singleton ProjectService instance
     */
    public static getInstance(projectOrPath?: SfProject | string): ProjectService {
        if (!ProjectService.instance) {
            ProjectService.instance = new ProjectService(projectOrPath);
        }
        return ProjectService.instance;
    }

    /**
     * Resets the singleton instance (useful for testing)
     */
    public static resetInstance(): void {
        ProjectService.instance = undefined;
    }

    /**
     * Initializes the service by loading the project configuration and building the graph
     */
    public async initialize(): Promise<void> {
        if (this.initialized) return;

        let sfProject: SfProject;
        if (this.projectOrPath instanceof SfProject) {
            sfProject = this.projectOrPath;
        } else {
            sfProject = await SfProject.resolve(this.projectOrPath);
        }

        this.projectConfig = new ProjectConfig(sfProject);
        this.versionManager = new VersionManager({
            projectConfig: this.projectConfig
        });

        await this.versionManager.load();
        this.initialized = true;
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
        const service = ProjectService.getInstance(workingDirectory);
        await service.initialize();
        return service.getProjectConfig().getProjectDefinition();
    }

    /**
     * Static helper to get a specific package definition
     */
    public static async getPackageDefinition(packageName: string, workingDirectory?: string): Promise<PackageDefinition> {
        const service = ProjectService.getInstance(workingDirectory);
        await service.initialize();
        return service.getProjectConfig().getPackageDefinition(packageName);
    }

    /**
     * Static helper to get all transitive dependencies of a package
     */
    public static async getPackageDependencies(packageName: string, workingDirectory?: string): Promise<PackageDefinition[]> {
        const service = ProjectService.getInstance(workingDirectory);
        await service.initialize();
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
        const service = ProjectService.getInstance(workingDirectory);
        await service.initialize();
        return service.getProjectConfig().getPackageType(packageName);
    }
}