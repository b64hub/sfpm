import {SfProject} from '@salesforce/core';
import path from 'node:path';

import type {
  ProjectDefinitionProvider,
  ResolveForPackageOptions,
} from './providers/project-definition-provider.js';

import {SfpmConfig} from '../types/config.js';
import {PackageType} from '../types/package.js';
import {PackageDefinition, ProjectDefinition} from '../types/project.js';
import {loadSfpmConfig} from './config-loader.js';
import {toSalesforceProjectJson} from './package-json-adapter.js';
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

  /**
   * Creates and initializes a new ProjectService instance from a directory path.
   */
  public static async create(projectPath?: string, provider?: ProjectDefinitionProvider): Promise<ProjectService> {
    const resolvedPath = projectPath ?? process.cwd();

    const projectRoot = ProjectService.findWorkspaceRoot(resolvedPath) ?? resolvedPath;
    const sfpmConfig = await loadSfpmConfig(projectRoot);

    const definitionProvider = provider ?? await ProjectService.detectProvider(projectRoot, sfpmConfig);
    const {definition} = definitionProvider.resolve();
    const graph = new ProjectGraph(definitionProvider);

    if (definitionProvider instanceof WorkspaceProvider) {
      WorkspaceProvider.ensureSfdxProject(projectRoot, definition);
    }

    const sfProject = await SfProject.resolve(projectRoot);

    return new ProjectService(sfProject, graph, sfpmConfig, definitionProvider);
  }

  /**
   * Creates a ProjectService instance from an existing SfProject.
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

  public static async getPackageDependencies(packageName: string, workingDirectory?: string): Promise<PackageDefinition[]> {
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
        projectDir,
        sfdcLoginUrl: sfpmConfig.sfdcLoginUrl,
        sourceApiVersion: sfpmConfig.sourceApiVersion,
        sourceBehaviorOptions: sfpmConfig.sourceBehaviorOptions,
      });
    }

    const sfProject = await SfProject.resolve(projectDir);
    return new SfdxProjectProvider(sfProject);
  }

  /**
   * Walk up the directory tree from `startDir` to find the nearest workspace root
   * (a directory containing pnpm-workspace.yaml or a package.json with "workspaces").
   * Returns the workspace root path, or undefined if none is found.
   */
  private static findWorkspaceRoot(startDir: string): string | undefined {
    let dir = path.resolve(startDir);
    const {root} = path.parse(dir);

    while (dir !== root) {
      if (WorkspaceProvider.hasWorkspace(dir)) {
        return dir;
      }

      dir = path.dirname(dir);
    }

    return undefined;
  }

  // =========================================================================
  // Resolution (delegates to provider)
  // =========================================================================

  /** Absolute path to the project root directory. */
  public get projectDirectory(): string {
    return this.definitionProvider.projectDir;
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

  public getDependencies(packageName: string): PackageDefinition[] {
    return this.definitionProvider.getDependencies(packageName);
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
    const sfProjectJson = toSalesforceProjectJson(definition);
    const projectJson = this.sfProject.getSfProjectJson();
    projectJson.set('packageDirectories', (sfProjectJson as any).packageDirectories);
    if ((sfProjectJson as any).packageAliases) {
      projectJson.set('packageAliases', (sfProjectJson as any).packageAliases as Record<string, string>);
    }

    if (sfProjectJson.sourceApiVersion) {
      projectJson.set('sourceApiVersion', sfProjectJson.sourceApiVersion as string);
    }

    await projectJson.write();
  }
}
