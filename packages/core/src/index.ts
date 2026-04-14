import {EventEmitter} from 'node:events';

import ProjectService from './project/project-service.js';
import {AllBuildEvents} from './types/events.js';
// Import builders to trigger decorator registration
import './package/builders/unlocked-package-builder.js';
import './package/builders/source-package-builder.js';
// Import installers to trigger decorator registration
import './package/installers/unlocked-package-installer.js';
import './package/installers/source-package-installer.js';
import './package/installers/managed-package-installer.js';
// Import analyzers to trigger decorator registration
import './package/analyzers/apex-type-analyzer.js';
import './package/analyzers/fht-analyzer.js';
import './package/analyzers/ft-analyzer.js';
import './package/analyzers/manifest-analyzer.js';
import './package/analyzers/picklist-analyzer.js';

export class SfpmCore extends EventEmitter<AllBuildEvents> {
  project!: ProjectService;

  private constructor() {
    super();
  }

  /**
   * Creates and initializes a new SfpmCore instance.
   * This is the recommended way to create an SfpmCore instance.
   */
  static async create(options: {apiKey: string; projectPath?: string; verbose?: boolean;}): Promise<SfpmCore> {
    const core = new SfpmCore();
    core.project = await ProjectService.create(options.projectPath);
    return core;
  }
}
export {default as ArtifactAssembler, type ArtifactAssemblerOptions, type ChangelogProvider} from './artifacts/artifact-assembler.js';
export {ArtifactRepository} from './artifacts/artifact-repository.js';
export {ArtifactResolver} from './artifacts/artifact-resolver.js';

export {
  type ArtifactHistoryOptions, ArtifactService, type InstallTarget, type SfpmArtifactHistory__c, // eslint-disable-line camelcase
} from './artifacts/artifact-service.js';
export {
  extractPackageVersionId, extractSourceHash, fromNpmPackageJson, toNpmPackageJson, type ToNpmPackageJsonOptions,
} from './artifacts/npm-package-adapter.js';
export {
  type DownloadResult,
  PnpmRegistryClient,
  RegistryClient,
  type RegistryClientConfig,
  type RegistryPackageInfo,
  type RegistryVersionInfo,
} from './artifacts/registry/index.js';
export {GitService} from './git/git-service.js';
export {default as Git} from './git/git.js';
// Lifecycle engine and config
export {isHookEnabled, type ResolvedHookConfig, resolveHookConfig} from './lifecycle/hook-config.js';
export {LifecycleEngine} from './lifecycle/lifecycle-engine.js';
export {DEFAULT_STAGE, type Stage, Stages} from './lifecycle/stages.js';
export {BuildOrchestrationTask, BuildOrchestrator, type BuildOrchestratorOptions} from './orchestrator/build-orchestrator.js';
export {InstallOrchestrationTask, InstallOrchestrator, type InstallOrchestratorOptions} from './orchestrator/install-orchestrator.js';
export {
  type OrchestrationTask, Orchestrator, type OrchestratorEmitter, type OrchestratorOptions,
} from './orchestrator/orchestrator.js';
export {AnalyzerRegistry, type PackageAnalyzer} from './package/analyzers/analyzer-registry.js';
export {
  type Builder, type BuilderConstructor, type BuilderOptions, BuilderRegistry, type BuildTask, RegisterBuilder,
} from './package/builders/builder-registry.js';
export {
  type Installer, type InstallerConstructor, type InstallerExecResult, InstallerRegistry, RegisterInstaller,
} from './package/installers/installer-registry.js';
export {
  type DataDeployable, ManagedPackageRef, type SourceDeployable, type VersionInstallable,
} from './package/installers/types.js';
export {PackageBuilder} from './package/package-builder.js'; // Avoid export * due to BuildOptions name conflict with types/project.ts
export {PackageCreator} from './package/package-creator.js';
export {type InstallOptions, type InstallResult, default as PackageInstaller} from './package/package-installer.js';
export {type Package2, PackageService, type SubscriberPackage} from './package/package-service.js';
export {
  type PackageValidationResult, ValidationPoller, type ValidationPollingOptions, type ValidationTarget,
} from './package/services/validation-poller.js';
export {PackageFactory, SfpmDataPackage, default as SfpmPackage} from './package/sfpm-package.js';
export {loadSfpmConfig, resolveConfigPath} from './project/config-loader.js';
export {
  collectPackageAliases, stripScope, toManagedPackageDefinitions, toPackageDefinition,
} from './project/package-json-adapter.js';
export * from './project/project-graph.js';
export {default as ProjectService} from './project/project-service.js';
export {
  type ClassifiedDependencies,
  type PackageDependency,
  type ProjectDefinitionProvider,
  type ProjectDefinitionResult,
  type ResolveForPackageOptions,
} from './project/providers/project-definition-provider.js';
export {SfdxProjectProvider} from './project/providers/sfdx-project-provider.js';
export {type WorkspaceProviderOptions as WorkspaceDefinitionProviderOptions, WorkspaceProvider} from './project/providers/workspace-provider.js';
export * from './project/version-manager.js';
export {
  type MigrateOptions, WorkspaceInitializer, type WorkspaceInitOptions, type WorkspaceInitResult,
} from './project/workspace-init.js';
export {WorkspaceSync, type WorkspaceSyncOptions} from './project/workspace-sync.js';
export * from './types/artifact.js';
export * from './types/bootstrap.js';
export * from './types/build-state.js';
export * from './types/config.js';
export * from './types/errors.js';
export * from './types/events.js';
export * from './types/lifecycle.js';
export * from './types/logger.js';
export * from './types/npm.js';
export * from './types/org.js';
export * from './types/package.js';
export * from './types/project.js';
export * from './types/workspace.js';
export {BuildStateStore} from './utils/build-state-store.js';
export {DirectoryHasher} from './utils/directory-hasher.js';
export {getPipelineRunId} from './utils/pipeline.js';
export {escapeSOQL, soql} from './utils/soql.js';
export {
  formatVersion, getVersionSuffix, stripBuildSegment, toSalesforceVersionWithToken, toVersionFormat,
} from './utils/version-utils.js';
export type {VersionFormatOptions} from './utils/version-utils.js';
