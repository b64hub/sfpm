import { SfProject } from '@salesforce/core';
import ProjectConfig from './project-config.js';
import { ProjectGraph } from './project-graph.js';
import { VersionManager, VersionManagerConfig } from './version-manager.js';
import { ProjectDefinition, PackageDefinition } from './types.js';
import { PackageType } from '../types/package.js';

export default class ProjectService {
    private versionManager: VersionManager;
    private projectConfig: ProjectConfig;

    constructor(projectOrPath?: SfProject | string) {
        this.projectConfig = new ProjectConfig(projectOrPath);
        this.versionManager = new VersionManager({
            projectConfig: this.projectConfig
        });
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
        const config = new ProjectConfig(workingDirectory);
        return await config.load();
    }

    /**
     * Static helper to get a specific package definition
     */
    public static async getPackageDefinition(packageName: string, workingDirectory?: string): Promise<PackageDefinition> {
        const config = new ProjectConfig(workingDirectory);
        await config.load();
        return config.getPackageDefinition(packageName);
    }

    /**
     * Static helper to get package type
     */
    public static async getPackageType(packageName: string, workingDirectory?: string): Promise<PackageType> {
        const config = new ProjectConfig(workingDirectory);
        await config.load();
        return config.getPackageType(packageName);
    }
}