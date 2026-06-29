import ProjectService from './project/project-service.js';
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
import './package/analyzers/picklist-analyzer.js';

/**
 * @deprecated dead code
 */
export class SfpmCore {
  project!: ProjectService;

  private constructor() {}

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
export {ApexClassifier, type ApexClassInfo} from './apex/apex-classifier.js';
export {
  ApexTestService, type ClassCoverage, type RunTestsOptions, type TestClassResult, type TestMethodResult, type TestRunResult,
} from './apex/apex-test-service.js';
export {default as ArtifactAssembler, type ArtifactAssemblerOptions, type ChangelogProvider} from './artifacts/artifact-assembler.js';

export {ArtifactRepository} from './artifacts/artifact-repository.js';
export {ArtifactResolver, type DownloadTarget} from './artifacts/artifact-resolver.js';
export {
  type ArtifactHistoryOptions, type ArtifactResolution, ArtifactService, type SfpmArtifactHistory__c, // eslint-disable-line camelcase
} from './artifacts/artifact-service.js';
export {
  extractPackageVersionId, extractSourceHash, fromNpmPackageJson, hydrateFromNpmPackageJson, toNpmPackageJson, type ToNpmPackageJsonOptions,
} from './artifacts/npm-package-adapter.js';
export {
  type DownloadResult,
  PnpmRegistryClient,
  RegistryClient,
  type RegistryClientConfig,
  type RegistryPackageInfo,
  type RegistryVersionInfo,
} from './artifacts/registry/index.js';
export * from './events/index.js';
export {GitService} from './git/git-service.js';
export {default as Git} from './git/git.js';
// Lifecycle engine and config
export {isHookEnabled, type ResolvedHookConfig, resolveHookConfig} from './lifecycle/hook-config.js';
export {LifecycleEngine} from './lifecycle/lifecycle-engine.js';
export {BuildOrchestrationTask, BuildOrchestrator, type BuildOrchestratorOptions} from './orchestrator/build-orchestrator.js';
export {InstallOrchestrationTask, InstallOrchestrator, type InstallOrchestratorOptions} from './orchestrator/install-orchestrator.js';
export {
  type OrchestrationTask, Orchestrator, type OrchestratorOptions,
} from './orchestrator/orchestrator.js';
export {AnalyzerRegistry, type PackageAnalyzer} from './package/analyzers/analyzer-registry.js';
export {
  type Builder, type BuilderConstructor, builderFactory, type BuilderOptions, BuilderRegistry,
  type BuilderResult, type BuildTask, type BuildTaskContext,
  type BuildTaskEnrichments, type BuildTaskRegistration,
  type BuildTaskResult,
  type DependencyAnalysis, RegisterBuilder,
} from './package/builders/builder-registry.js';
export {assembleArtifactTask, default as AssembleArtifactTask, type AssembleArtifactTaskOptions} from './package/builders/tasks/assemble-artifact-task.js';
export {
  type InstallCheckResult, type Installer, type InstallerConstructor, InstallerRegistry, type InstallerResult, RegisterInstaller,
} from './package/installers/installer-registry.js';
export {
  type DataDeployable, ManagedPackageRef, type SourceDeployable, type VersionInstallable,
} from './package/installers/types.js';
export {ORG_ALIAS_DEFAULT_DIR, type OrgAliasResolution, OrgAliasResolver} from './package/org-alias-resolver.js';
export {type BuildOptions, PackageBuilder, type ValidationLevel} from './package/package-builder.js';
export {type PackageCreateConfig, type PackageCreationResult, PackageCreator} from './package/package-creator.js';
export {type InstallOptions, type InstallResult, default as PackageInstaller} from './package/package-installer.js';
export {type Package2, PackageService} from './package/package-service.js';
export {
  isOrgAliasable, type OrgAliasable, PackageFactory, SfpmDataPackage, default as SfpmPackage,
} from './package/sfpm-package.js';
export {
  type PackageValidationResult, ValidationPoller, type ValidationPollingOptions, type ValidationTarget,
} from './package/validation/validation-poller.js';
export {type ResolveOptions, ValidationResolver} from './package/validation/validation-resolver.js';
export {loadSfpmConfig, resolveConfigPath} from './project/config-loader.js';
export * from './project/project-graph.js';
export {default as ProjectService} from './project/project-service.js';
export {
  type ProjectDefinitionProvider,
  type ProjectDefinitionResult,
  type ResolveForPackageOptions,
} from './project/providers/project-definition-provider.js';
export {
  fromSalesforceProjectJson, type PackageDependency,
  type PackageDirectory, type ProjectJsonOptions, type SalesforceProjectJson, toSalesforceProjectJson,
} from './project/providers/sfdx-project-adapter.js';
export {SfdxProjectProvider} from './project/providers/sfdx-project-provider.js';
export * from './project/providers/types/workspace.js';
export {toPackageDefinition} from './project/providers/workspace-adapter.js';
export {type WorkspaceProviderOptions as WorkspaceDefinitionProviderOptions, WorkspaceProvider} from './project/providers/workspace-provider.js';
export * from './project/version-manager.js';
export {
  type MigrateOptions, WorkspaceInitializer, type WorkspaceInitOptions, type WorkspaceInitResult,
} from './project/workspace-init.js';
export {WorkspaceSync, type WorkspaceSyncOptions} from './project/workspace-sync.js';
export {
  type DeployComponentError, type DeployOptions, type DeployProgress, type DeployResult,
  type TestRunResult as DeployTestRunResult, MetadataDeployService, type TestFailure,
} from './tooling/metadata-deploy-service.js';
export * from './types/artifact.js';
export {
  type LocalBuildState,
  type LocalPackageBuildState,
  type LocalValidationResult,
} from './types/build-state.js';
export * from './types/config.js';
export * from './types/dependency-analysis.js';
export * from './types/errors.js';
export * from './types/lifecycle.js';
export * from './types/logger.js';
export * from './types/npm.js';
export * from './types/org.js';
export * from './types/package.js';
export * from './types/project.js';
export * from './types/watcher.js';
export {BuildStateStore} from './utils/build-state-store.js';
export {DirectoryHasher} from './utils/directory-hasher.js';
export {getPipelineRunId} from './utils/pipeline.js';
export {resolvePackageName, stripScope} from './utils/scope-utils.js';
export {escapeSOQL, soql} from './utils/soql.js';
export {
  formatVersion, getVersionSuffix, stripBuildSegment, toSalesforceVersionWithToken, toVersionFormat,
} from './utils/version-utils.js';
export type {VersionFormatOptions} from './utils/version-utils.js';
export {ApexTestPollingStrategy} from './watcher/strategies/apex-test-strategy.js';
export {BuildPollingStrategy} from './watcher/strategies/build-strategy.js';
export {DeployPollingStrategy} from './watcher/strategies/deploy-strategy.js';
export {registeredJobTypes, resolveStrategy} from './watcher/strategy-registry.js';
export {WatcherStateStore} from './watcher/watcher-state-store.js';
