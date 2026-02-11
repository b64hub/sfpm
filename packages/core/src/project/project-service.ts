import {SfProject} from '@salesforce/core';

import {PackageType} from '../types/package.js';
import {ManagedPackageDefinition, PackageDefinition, ProjectDefinition} from '../types/project.js';
import ProjectConfig from './project-config.js';
import {ProjectGraph} from './project-graph.js';
import {VersionManager} from './version-manager.js';

export default class ProjectService {
  private static instance: ProjectService | undefined;
  private readonly graph: ProjectGraph;
  private readonly projectConfig: ProjectConfig;

  private constructor(projectConfig: ProjectConfig, graph: ProjectGraph) {
    this.projectConfig = projectConfig;
    this.graph = graph;
  }

  /**
   * Static helper to classify a package's dependencies into versioned and managed.
   * Returns raw sfdx-project.json names — callers apply npm scope as needed.
   */
  public static async classifyDependencies(
    packageName: string,
    workingDirectory?: string,
  ): Promise<import('./project-config.js').ClassifiedDependencies> {
    const service = await ProjectService.getInstance(workingDirectory);
    return service.getProjectConfig().classifyDependencies(packageName);
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
    const definition = projectConfig.getProjectDefinition();
    const graph = new ProjectGraph(definition);

    return new ProjectService(projectConfig, graph);
  }

  /**
   * Creates and initializes a new ProjectService instance from an existing SfProject.
   *
   * @param project - SfProject instance
   * @returns Fully initialized ProjectService instance
   */
  public static createFromProject(project: SfProject): ProjectService {
    const projectConfig = new ProjectConfig(project);
    const definition = projectConfig.getProjectDefinition();
    const graph = new ProjectGraph(definition);

    return new ProjectService(projectConfig, graph);
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
   * Static helper to get a specific package definition
   */
  public static async getPackageDefinition(packageName: string, workingDirectory?: string): Promise<PackageDefinition> {
    const service = await ProjectService.getInstance(workingDirectory);
    return service.getProjectConfig().getPackageDefinition(packageName);
  }

  /**
   * Static helper to get all transitive dependencies of a package
   */
  public static async getPackageDependencies(packageName: string, workingDirectory?: string): Promise<(ManagedPackageDefinition | PackageDefinition)[]> {
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

  /**
   * Static helper to get the project definition
   */
  public static async getProjectDefinition(workingDirectory?: string): Promise<ProjectDefinition> {
    const service = await ProjectService.getInstance(workingDirectory);
    return service.getProjectConfig().getProjectDefinition();
  }

  /**
   * Resets the singleton instance (useful for testing)
   */
  public static resetInstance(): void {
    ProjectService.instance = undefined;
  }

  /**
   * Creates a VersionManager backed by this service's graph and definition.
   */
  public createVersionManager(): VersionManager {
    const definition = this.projectConfig.getProjectDefinition();
    return VersionManager.create(this.graph, definition);
  }

  /**
   * Returns the ProjectConfig instance managed by this service
   */
  public getProjectConfig(): ProjectConfig {
    return this.projectConfig;
  }

  /**
   * Returns the shared ProjectGraph instance built once during service creation.
   */
  public getProjectGraph(): ProjectGraph {
    return this.graph;
  }

  /**
   * Persists an updated ProjectDefinition to sfdx-project.json.
   * Typically called after VersionManager.getUpdatedDefinition().
   */
  public async saveProjectDefinition(definition: ProjectDefinition): Promise<void> {
    await this.projectConfig.save(definition);
  }
}
