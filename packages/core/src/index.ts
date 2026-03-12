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
/* eslint-disable camelcase */
export {
  type ArtifactHistoryOptions, ArtifactService, type InstallTarget, type SfpmArtifactHistory__c,
} from './artifacts/artifact-service.js';
/* eslint-enable camelcase */
export {
  type DownloadResult,
  type NpmConfigResult,
  NpmRegistryClient,
  readNpmConfig,
  readNpmConfigSync,
  RegistryClient,
  type RegistryClientConfig,
  type RegistryPackageInfo,
  type RegistryVersionInfo,
} from './artifacts/registry/index.js';
export {GitService} from './git/git-service.js';
export {default as Git} from './git/git.js';
// Lifecycle engine and config
export {LifecycleEngine} from './lifecycle/lifecycle-engine.js';
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
export {type InstallOptions, type InstallResult, default as PackageInstaller} from './package/package-installer.js';
export {PackageFactory, SfpmDataPackage, default as SfpmPackage} from './package/sfpm-package.js';
export {loadSfpmConfig, resolveConfigPath} from './project/config-loader.js';
export {default as ProjectConfig} from './project/project-config.js';
export * from './project/project-graph.js';
export {default as ProjectService} from './project/project-service.js';
export * from './project/version-manager.js';
export * from './types/artifact.js';
export * from './types/config.js';
export * from './types/errors.js';
export * from './types/events.js';
export * from './types/lifecycle.js';
export * from './types/logger.js';
export * from './types/npm.js';
export * from './types/package.js';
export * from './types/project.js';
export {DirectoryHasher} from './utils/directory-hasher.js';
export {getPipelineRunId} from './utils/pipeline.js';
export {escapeSOQL, soql} from './utils/soql.js';
export {formatVersion, toVersionFormat} from './utils/version-utils.js';
export type {VersionFormatOptions} from './utils/version-utils.js';
