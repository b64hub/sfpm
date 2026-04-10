import {PackageType} from './package.js';

// ============================================================================
// Base Event Interfaces
// ============================================================================

/**
 * Base event that all build events extend
 */
export interface BaseEvent {
  packageName: string;
  timestamp: Date;
}

// ============================================================================
// Core Build Lifecycle Events
// ============================================================================

export interface BuildStartEvent extends BaseEvent {
  buildNumber?: string;
  packageType: PackageType;
  version?: string;
}

export interface BuildCompleteEvent extends BaseEvent {
  artifactPath?: string;
  packageVersionId?: string;
  reason?: string;
  skipped?: boolean;
  success: boolean;
}

export interface BuildSkippedEvent extends BaseEvent {
  artifactPath?: string;
  latestVersion?: string;
  packageType: PackageType;
  reason: 'already-built' | 'empty-package' | 'no-changes';
  sourceHash?: string;
  version?: string;
}

export interface BuildErrorEvent extends BaseEvent {
  error: Error;
  phase: 'analysis' | 'build' | 'connection' | 'post-build' | 'staging';
}

// ============================================================================
// Staging Events
// ============================================================================

export interface StageStartEvent extends BaseEvent {
  stagingDirectory?: string;
}

export interface StageCompleteEvent extends BaseEvent {
  componentCount: number;
  stagingDirectory: string;
}

// ============================================================================
// Analyzer Events
// ============================================================================

export interface AnalyzersStartEvent extends BaseEvent {
  analyzerCount: number;
}

export interface AnalyzerStartEvent extends BaseEvent {
  analyzerName: string;
}

export interface AnalyzerCompleteEvent extends BaseEvent {
  analyzerName: string;
  error?: string;
  findings?: Record<string, any>;
}

export interface AnalyzersCompleteEvent extends BaseEvent {
  completedCount: number;
}

// ============================================================================
// Connection Events
// ============================================================================

export interface ConnectionStartEvent extends BaseEvent {
  orgType: 'devhub' | 'production' | 'sandbox';
  username: string;
}

export interface ConnectionCompleteEvent extends BaseEvent {
  orgId?: string;
  username: string;
}

// ============================================================================
// Builder Execution Events
// ============================================================================

export interface BuilderStartEvent extends BaseEvent {
  builderName: string;
  packageType: PackageType;
}

export interface BuilderCompleteEvent extends BaseEvent {
  builderName: string;
  packageType: PackageType;
}

// ============================================================================
// Unlocked Package Specific Events
// ============================================================================

export interface PruneStartEvent extends BaseEvent {
  reason: string;
}

export interface PruneCompleteEvent extends BaseEvent {
  prunedFiles: number;
}

export interface CreateStartEvent extends BaseEvent {
  packageId?: string;
  versionNumber: string;
}

export interface CreateProgressEvent extends BaseEvent {
  message?: string;
  percentComplete?: number;
  status: string;
}

export interface CreateCompleteEvent extends BaseEvent {
  codeCoverage?: null | number;
  createdDate?: string;
  hasMetadataRemoved?: boolean;
  hasPassedCodeCoverageCheck?: boolean;
  packageId?: string;
  /** The Package2VersionCreateRequest ID — used to poll async validation status */
  packageVersionCreateRequestId?: string;
  packageVersionId: string;
  status?: string;
  subscriberPackageVersionId?: string;
  totalNumberOfMetadataFiles?: number;
  totalSizeOfMetadataFiles?: number;
  versionNumber: string;
}

export interface ValidationStartEvent extends BaseEvent {
  validationType: 'apex' | 'dependencies' | 'metadata';
}

export interface ValidationCompleteEvent extends BaseEvent {
  details?: string;
  passed: boolean;
  validationType: 'apex' | 'dependencies' | 'metadata';
}

// ============================================================================
// Source Package Specific Events
// ============================================================================

export interface SourceAssembleStartEvent extends BaseEvent {
  sourcePath: string;
}

export interface SourceAssembleCompleteEvent extends BaseEvent {
  artifactPath: string;
  sourcePath: string;
}

export interface SourceTestStartEvent extends BaseEvent {
  testCount: number;
}

export interface SourceTestCompleteEvent extends BaseEvent {
  failed: number;
  passed: number;
  testCount: number;
}

// ============================================================================
// Task Events
// ============================================================================

export interface TaskStartEvent extends BaseEvent {
  taskName: string;
  taskType: 'post-build' | 'pre-build';
}

export interface TaskCompleteEvent extends BaseEvent {
  success: boolean;
  taskName: string;
  taskType: 'post-build' | 'pre-build';
}

// ============================================================================
// Event Type Maps (for type-safe EventEmitter usage)
// ============================================================================

/**
 * Core build events emitted by PackageBuilder
 */
export interface BuildEvents {
  'analyzer:complete': [AnalyzerCompleteEvent];
  'analyzer:start': [AnalyzerStartEvent];
  'analyzers:complete': [AnalyzersCompleteEvent];
  'analyzers:start': [AnalyzersStartEvent];

  'build:complete': [BuildCompleteEvent];
  'build:error': [BuildErrorEvent];

  'build:skipped': [BuildSkippedEvent];
  'build:start': [BuildStartEvent];
  'builder:complete': [BuilderCompleteEvent];
  'builder:start': [BuilderStartEvent];

  'connection:complete': [ConnectionCompleteEvent];
  'connection:start': [ConnectionStartEvent];

  'stage:complete': [StageCompleteEvent];
  'stage:start': [StageStartEvent];

  'task:complete': [TaskCompleteEvent];
  'task:start': [TaskStartEvent];
}

/**
 * Unlocked package builder specific events
 */
export interface UnlockedBuildEvents {
  'task:complete': [TaskCompleteEvent];
  'task:start': [TaskStartEvent];
  'unlocked:create:complete': [CreateCompleteEvent];
  'unlocked:create:progress': [CreateProgressEvent];
  'unlocked:create:start': [CreateStartEvent];
  'unlocked:prune:complete': [PruneCompleteEvent];
  'unlocked:prune:start': [PruneStartEvent];
  'unlocked:validation:complete': [ValidationCompleteEvent];
  'unlocked:validation:start': [ValidationStartEvent];
}

/**
 * Source package builder specific events
 */
export interface SourceBuildEvents {
  'source:assemble:complete': [SourceAssembleCompleteEvent];
  'source:assemble:start': [SourceAssembleStartEvent];
  'source:test:complete': [SourceTestCompleteEvent];
  'source:test:start': [SourceTestStartEvent];
  'task:complete': [TaskCompleteEvent];
  'task:start': [TaskStartEvent];
}

// ============================================================================
// Artifact Assembly Events
// ============================================================================

export interface AssemblyStartEvent extends BaseEvent {
  version: string;
}

export interface AssemblyPackEvent extends BaseEvent {
  tarballName: string;
}

export interface AssemblyCompleteEvent extends BaseEvent {
  artifactHash: string;
  artifactPath: string;
  duration: number;
  sourceHash: string;
  version: string;
}

export interface AssemblyErrorEvent extends BaseEvent {
  error: Error;
  version: string;
}

/**
 * Artifact assembly events emitted by ArtifactAssembler
 */
export interface AssemblyEvents {
  'assembly:complete': [AssemblyCompleteEvent];
  'assembly:error': [AssemblyErrorEvent];
  'assembly:pack': [AssemblyPackEvent];
  'assembly:start': [AssemblyStartEvent];
}

/**
 * Combined event map for all build events
 */
export type AllBuildEvents = AssemblyEvents & BuildEvents & SourceBuildEvents & UnlockedBuildEvents;

// ============================================================================
// Install Events (typed)
// ============================================================================

export interface InstallStartEvent extends BaseEvent {
  installReason?: string;
  packageType: PackageType;
  packageVersionId?: string;
  source?: string;
  targetOrg: string;
  versionNumber?: string;
}

export interface InstallSkipEvent extends BaseEvent {
  packageType: PackageType;
  reason: string;
  targetOrg: string;
}

export interface InstallCompleteEvent extends BaseEvent {
  packageType: PackageType;
  packageVersionId?: string;
  source?: string;
  success: boolean;
  targetOrg: string;
  versionNumber?: string;
}

export interface InstallErrorEvent extends BaseEvent {
  error: string;
  packageType: PackageType;
  packageVersionId?: string;
  targetOrg: string;
  versionNumber?: string;
}

export interface DeploymentStartEvent extends BaseEvent {
  targetOrg: string;
}

export interface DeploymentProgressEvent extends BaseEvent {
  numberComponentsDeployed?: number;
  numberComponentsTotal?: number;
  status: string;
}

export interface DeploymentCompleteEvent extends BaseEvent {
  numberComponentsDeployed?: number;
  targetOrg: string;
}

export interface VersionInstallStartEvent extends BaseEvent {
  packageVersionId: string;
}

export interface VersionInstallProgressEvent extends BaseEvent {
  status: string;
}

export interface VersionInstallCompleteEvent extends BaseEvent {
  packageVersionId: string;
}

/**
 * Install event map for type-safe EventEmitter usage
 */
export interface InstallEvents {
  'connection:complete': [ConnectionCompleteEvent];
  'connection:start': [ConnectionStartEvent];
  'deployment:complete': [DeploymentCompleteEvent];
  'deployment:progress': [DeploymentProgressEvent];
  'deployment:start': [DeploymentStartEvent];
  'install:complete': [InstallCompleteEvent];
  'install:error': [InstallErrorEvent];
  'install:skip': [InstallSkipEvent];
  'install:start': [InstallStartEvent];
  'version-install:complete': [VersionInstallCompleteEvent];
  'version-install:progress': [VersionInstallProgressEvent];
  'version-install:start': [VersionInstallStartEvent];
}

// ============================================================================
// Orchestration Events
// ============================================================================

/**
 * Result of a single package build/install within an orchestration run
 */
export interface PackageResult {
  duration: number;
  error?: string;
  packageName: string;
  skipped: boolean;
  success: boolean;
}

export interface OrchestrationStartEvent {
  includeDependencies: boolean;
  packageNames: string[];
  timestamp: Date;
  totalLevels: number;
  totalPackages: number;
}

export interface OrchestrationLevelStartEvent {
  level: number;
  /** Enriched package info for display purposes */
  packageDetails: Array<{isManaged: boolean; name: string; version?: string;}>;
  packages: string[];
  timestamp: Date;
}

export interface OrchestrationPackageCompleteEvent {
  duration: number;
  error?: string;
  level: number;
  packageName: string;
  skipped: boolean;
  success: boolean;
  timestamp: Date;
}

export interface OrchestrationLevelCompleteEvent {
  failed: string[];
  level: number;
  skipped: string[];
  succeeded: string[];
  timestamp: Date;
}

export interface OrchestrationCompleteEvent {
  results: PackageResult[];
  timestamp: Date;
  totalDuration: number;
}

export interface OrchestrationErrorEvent {
  error: Error;
  packageName?: string;
  timestamp: Date;
}

/**
 * Event map for orchestration-level events
 */
export interface OrchestrationEvents {
  'orchestration:complete': [OrchestrationCompleteEvent];
  'orchestration:error': [OrchestrationErrorEvent];
  'orchestration:level:complete': [OrchestrationLevelCompleteEvent];
  'orchestration:level:start': [OrchestrationLevelStartEvent];
  'orchestration:package:complete': [OrchestrationPackageCompleteEvent];
  'orchestration:start': [OrchestrationStartEvent];
}

/**
 * Aggregated result of a multi-package orchestration run
 */
export interface OrchestrationResult {
  duration: number;
  failedPackages: string[];
  results: PackageResult[];
  skippedPackages: string[];
  success: boolean;
}
