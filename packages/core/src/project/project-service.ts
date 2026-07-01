import {SfProject} from '@salesforce/core';
import path from 'node:path';

import type {SfpmConfig} from '../types/config.js';
import type {PackageType} from '../types/package.js';
import type {PackageDefinition, ProjectDefinition} from '../types/project.js';
import type {
  ProjectDefinitionProvider,
  ResolveForPackageOptions,
} from './providers/project-definition-provider.js';

import {loadSfpmConfig} from './config-loader.js';
import ProjectGraph from './project-graph.js';
import {SfdxProjectProvider} from './providers/sfdx-project-provider.js';
import {WorkspaceProvider} from './providers/workspace-provider.js';
import {VersionManager} from './version-manager.js';

// ---------------------------------------------------------------------------
// Provider detection — internal, keeps ProjectService instance agnostic
// ---------------------------------------------------------------------------

/**
 * Find the project root by trying each provider's root detection in priority order.
 * Workspace takes precedence over sfdx-project.json (workspace projects also have one).
 */
function findProjectRoot(startDir: string): string | undefined {
  return WorkspaceProvider.findProjectRoot(startDir)
    ?? SfdxProjectProvider.findProjectRoot(startDir);
}

/**
 * Detect and instantiate the appropriate provider for a project directory.
 */
async function detectProvider(projectDir: string, sfpmConfig: SfpmConfig): Promise<ProjectDefinitionProvider> {
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

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export default class ProjectService {
  private static instance: ProjectService | undefined;
  private readonly definitionProvider: ProjectDefinitionProvider;
  private readonly graph: ProjectGraph;
  private readonly sfpmConfig: SfpmConfig;

  private constructor(
    graph: ProjectGraph,
    sfpmConfig: SfpmConfig,
    definitionProvider: ProjectDefinitionProvider,
  ) {
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
    const projectRoot = findProjectRoot(resolvedPath) ?? resolvedPath;
    const sfpmConfig = await loadSfpmConfig(projectRoot);

    const definitionProvider = provider ?? await detectProvider(projectRoot, sfpmConfig);
    definitionProvider.resolve();

    const graph = ProjectGraph.buildGraph(definitionProvider.getProjectDefinition());

    return new ProjectService(graph, sfpmConfig, definitionProvider);
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

  public static async getPackageDefinition(packageName: string, workingDirectory?: string): Promise<PackageDefinition> {
    const service = await ProjectService.getInstance(workingDirectory);
    return service.getPackageDefinition(packageName);
  }

  // =========================================================================
  // Static convenience helpers
  // =========================================================================

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

  /**
   * Persists an updated ProjectDefinition via the active provider.
   */
  public async saveProjectDefinition(definition: ProjectDefinition): Promise<void> {
    for (const pkg of definition.packages) {
      // eslint-disable-next-line no-await-in-loop -- file writes sequentially to avoid locks
      await this.definitionProvider.updatePackageConfig(pkg.name, pkg);
    }
  }
}
