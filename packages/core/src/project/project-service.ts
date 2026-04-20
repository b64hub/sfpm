import {SfProject} from '@salesforce/core';

import type {
  ClassifiedDependencies,
  PackageDependency,
  ProjectDefinitionProvider,
  ResolveForPackageOptions,
} from './providers/project-definition-provider.js';

import {SfpmConfig} from '../types/config.js';
import {PackageType} from '../types/package.js';
import {ManagedPackageDefinition, PackageDefinition, ProjectDefinition} from '../types/project.js';
import {loadSfpmConfig} from './config-loader.js';
import {ProjectGraph} from './project-graph.js';
import {SfdxProjectProvider} from './providers/sfdx-project-provider.js';
import {WorkspaceProvider} from './providers/workspace-provider.js';
import {VersionManager} from './version-manager.js';

export default class ProjectService {
  private static instance: ProjectService | undefined;
  private readonly definitionProvider: ProjectDefinitionProvider;
  private readonly graph: ProjectGraph;
  private readonly sfpmConfig: SfpmConfig;
  private readonly sfProject: SfProject;

  private constructor(
    sfProject: SfProject,
    graph: ProjectGraph,
    sfpmConfig: SfpmConfig,
    definitionProvider: ProjectDefinitionProvider,
  ) {
    this.sfProject = sfProject;
    this.graph = graph;
    this.sfpmConfig = sfpmConfig;
    this.definitionProvider = definitionProvider;
  }

  // =========================================================================
  // Static factory / singleton
  // =========================================================================

  public static async classifyDependencies(
    packageName: string,
    workingDirectory?: string,
  ): Promise<ClassifiedDependencies> {
    const service = await ProjectService.getInstance(workingDirectory);
    return service.classifyDependencies(packageName);
  }

  /**
   * Creates and initializes a new ProjectService instance from a directory path.
   *
   * Auto-detects the project mode:
   * - **Workspace mode** (pnpm-workspace.yaml or package.json workspaces): builds the
   *   project graph from workspace package.json files via WorkspaceProvider.
   * - **Legacy mode**: builds the graph from sfdx-project.json via SfdxProjectProvider.
   *
   * You can also pass a custom ProjectDefinitionProvider to override auto-detection.
   */
  public static async create(projectPath?: string, provider?: ProjectDefinitionProvider): Promise<ProjectService> {
    const resolvedPath = projectPath ?? process.cwd();
    const sfpmConfig = await loadSfpmConfig(resolvedPath);

    const definitionProvider = provider ?? await ProjectService.detectProvider(resolvedPath, sfpmConfig);
    const {definition} = definitionProvider.resolve();
    const graph = new ProjectGraph(definitionProvider);

    // In workspace mode, write sfdx-project.json so @salesforce/core can load it.
    if (definitionProvider instanceof WorkspaceProvider) {
      WorkspaceProvider.ensureSfdxProject(resolvedPath, definition);
    }

    const sfProject = await SfProject.resolve(resolvedPath);

    return new ProjectService(sfProject, graph, sfpmConfig, definitionProvider);
  }

  /**
   * Creates a ProjectService instance from an existing SfProject.
   * Note: This is synchronous and uses an empty SfpmConfig. Prefer `create()` for full config loading.
   */
  public static createFromProject(project: SfProject, sfpmConfig: SfpmConfig = {}): ProjectService {
    const provider = new SfdxProjectProvider(project);
    const graph = new ProjectGraph(provider);

    return new ProjectService(project, graph, sfpmConfig, provider);
  }

  /**
   * Gets or creates the singleton ProjectService instance.
   */
  public static async getInstance(projectPath?: string): Promise<ProjectService> {
    if (!ProjectService.instance) {
      ProjectService.instance = await ProjectService.create(projectPath);
    }

    return ProjectService.instance;
  }

  // =========================================================================
  // Static convenience helpers
  // =========================================================================

  public static async getPackageDefinition(packageName: string, workingDirectory?: string): Promise<PackageDefinition> {
    const service = await ProjectService.getInstance(workingDirectory);
    return service.getPackageDefinition(packageName);
  }

  public static async getPackageDependencies(packageName: string, workingDirectory?: string): Promise<(ManagedPackageDefinition | PackageDefinition)[]> {
    const service = await ProjectService.getInstance(workingDirectory);
    return service.getProjectGraph().getTransitiveDependencies(packageName);
  }

  public static async getPackageType(packageName: string, workingDirectory?: string): Promise<PackageType> {
    const service = await ProjectService.getInstance(workingDirectory);
    return service.getPackageType(packageName);
  }

  public static async getProjectDefinition(workingDirectory?: string): Promise<ProjectDefinition> {
    const service = await ProjectService.getInstance(workingDirectory);
    return service.getProjectDefinition();
  }

  /** Resets the singleton instance (useful for testing). */
  public static resetInstance(): void {
    ProjectService.instance = undefined;
  }

  // =========================================================================
  // Provider detection
  // =========================================================================

  private static async detectProvider(projectDir: string, sfpmConfig: SfpmConfig): Promise<ProjectDefinitionProvider> {
    if (WorkspaceProvider.hasWorkspace(projectDir)) {
      return new WorkspaceProvider({
        namespace: sfpmConfig.namespace,
        projectDir,
        sfdcLoginUrl: sfpmConfig.sfdcLoginUrl,
        sourceApiVersion: sfpmConfig.sourceApiVersion,
        sourceBehaviorOptions: sfpmConfig.sourceBehaviorOptions,
      });
    }

    const sfProject = await SfProject.resolve(projectDir);
    return new SfdxProjectProvider(sfProject);
  }

  // =========================================================================
  // Resolution (delegates to provider)
  // =========================================================================

  /** Absolute path to the project root directory. */
  public get projectDirectory(): string {
    return this.definitionProvider.projectDir;
  }

  public classifyDependencies(packageName: string): ClassifiedDependencies {
    return this.definitionProvider.classifyDependencies(packageName);
  }

  // =========================================================================
  // Package queries (delegates to provider)
  // =========================================================================

  public createVersionManager(): VersionManager {
    const definition = this.getProjectDefinition();
    return VersionManager.create(this.graph, definition);
  }

  public getAllPackageDefinitions(): PackageDefinition[] {
    return this.definitionProvider.getAllPackageDefinitions();
  }

  public getAllPackageNames(): string[] {
    return this.definitionProvider.getAllPackageNames();
  }

  /** Returns the underlying provider. */
  public getDefinitionProvider(): ProjectDefinitionProvider {
    return this.definitionProvider;
  }

  public getDependencies(packageName: string): PackageDependency[] {
    return this.definitionProvider.getDependencies(packageName);
  }

  public getManagedPackages(): ManagedPackageDefinition[] {
    return this.definitionProvider.getManagedPackages();
  }

  public getPackageDefinition(packageName: string): PackageDefinition {
    return this.definitionProvider.getPackageDefinition(packageName);
  }

  // =========================================================================
  // Dependency queries (delegates to provider)
  // =========================================================================

  public getPackageDefinitionByPath(packagePath: string): PackageDefinition {
    return this.definitionProvider.getPackageDefinitionByPath(packagePath);
  }

  public getPackageId(packageAlias: string): string | undefined {
    return this.definitionProvider.getPackageId(packageAlias);
  }

  public getPackageType(packageName: string): PackageType {
    return this.definitionProvider.getPackageType(packageName);
  }

  // =========================================================================
  // Graph, config, services
  // =========================================================================

  public getProjectDefinition(): ProjectDefinition {
    return this.definitionProvider.resolve().definition;
  }

  public getProjectGraph(): ProjectGraph {
    return this.graph;
  }

  public getSfpmConfig(): SfpmConfig {
    return this.sfpmConfig;
  }

  /** Resolve a single-package ProjectDefinition for staging and building. */
  public resolveForPackage(packageName: string, options?: ResolveForPackageOptions): ProjectDefinition {
    return this.definitionProvider.resolveForPackage(packageName, options);
  }

  /** Persists an updated ProjectDefinition to sfdx-project.json. */
  public async saveProjectDefinition(definition: ProjectDefinition): Promise<void> {
    const projectJson = this.sfProject.getSfProjectJson();
    projectJson.set('packageDirectories', definition.packageDirectories);
    if (definition.packageAliases) {
      projectJson.set('packageAliases', definition.packageAliases);
    }

    if (definition.sourceApiVersion) {
      projectJson.set('sourceApiVersion', definition.sourceApiVersion);
    }

    await projectJson.write();
  }
}
