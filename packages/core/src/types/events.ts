import { PackageType } from "./package.js";

// ============================================================================
// Base Event Interfaces
// ============================================================================

/**
 * Base event that all build events extend
 */
export interface BaseEvent {
  timestamp: Date;
  packageName: string;
}

// ============================================================================
// Core Build Lifecycle Events
// ============================================================================

export interface BuildStartEvent extends BaseEvent {
  packageType: PackageType;
  buildNumber?: string;
  version?: string;
}

export interface BuildCompleteEvent extends BaseEvent {
  success: boolean;
  packageVersionId?: string;
  artifactPath?: string;
  skipped?: boolean;
  reason?: string;
}

export interface BuildSkippedEvent extends BaseEvent {
  reason: 'no-changes' | 'already-built';
  latestVersion: string;
  sourceHash: string;
  artifactPath?: string;
}

export interface BuildErrorEvent extends BaseEvent {
  error: Error;
  phase: 'staging' | 'analysis' | 'connection' | 'build' | 'post-build';
}

// ============================================================================
// Staging Events
// ============================================================================

export interface StageStartEvent extends BaseEvent {
  stagingDirectory?: string;
}

export interface StageCompleteEvent extends BaseEvent {
  stagingDirectory: string;
  componentCount: number;
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
  findings?: Record<string, any>;
}

export interface AnalyzersCompleteEvent extends BaseEvent {
  completedCount: number;
}

// ============================================================================
// Connection Events
// ============================================================================

export interface ConnectionStartEvent extends BaseEvent {
  username: string;
  orgType: 'devhub' | 'sandbox' | 'production';
}

export interface ConnectionCompleteEvent extends BaseEvent {
  username: string;
  orgId?: string;
}

// ============================================================================
// Builder Execution Events
// ============================================================================

export interface BuilderStartEvent extends BaseEvent {
  packageType: PackageType;
  builderName: string;
}

export interface BuilderCompleteEvent extends BaseEvent {
  packageType: PackageType;
  builderName: string;
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
  status: string;
  message?: string;
  percentComplete?: number;
}

export interface CreateCompleteEvent extends BaseEvent {
  packageVersionId: string;
  versionNumber: string;
  subscriberPackageVersionId?: string;
  packageId?: string;
  status?: string;
  codeCoverage?: number | null;
  hasPassedCodeCoverageCheck?: boolean;
  totalNumberOfMetadataFiles?: number;
  totalSizeOfMetadataFiles?: number;
  hasMetadataRemoved?: boolean;
  createdDate?: string;
}

export interface ValidationStartEvent extends BaseEvent {
  validationType: 'apex' | 'metadata' | 'dependencies';
}

export interface ValidationCompleteEvent extends BaseEvent {
  validationType: 'apex' | 'metadata' | 'dependencies';
  passed: boolean;
  details?: string;
}

// ============================================================================
// Source Package Specific Events
// ============================================================================

export interface SourceAssembleStartEvent extends BaseEvent {
  sourcePath: string;
}

export interface SourceAssembleCompleteEvent extends BaseEvent {
  sourcePath: string;
  artifactPath: string;
}

export interface SourceTestStartEvent extends BaseEvent {
  testCount: number;
}

export interface SourceTestCompleteEvent extends BaseEvent {
  testCount: number;
  passed: number;
  failed: number;
}

// ============================================================================
// Task Events
// ============================================================================

export interface TaskStartEvent extends BaseEvent {
  taskName: string;
  taskType: 'pre-build' | 'post-build';
}

export interface TaskCompleteEvent extends BaseEvent {
  taskName: string;
  taskType: 'pre-build' | 'post-build';
  success: boolean;
}

// ============================================================================
// Event Type Maps (for type-safe EventEmitter usage)
// ============================================================================

/**
 * Core build events emitted by PackageBuilder
 */
export interface BuildEvents {
  'build:start': [BuildStartEvent];
  'build:complete': [BuildCompleteEvent];
  'build:skipped': [BuildSkippedEvent];
  'build:error': [BuildErrorEvent];
  
  'stage:start': [StageStartEvent];
  'stage:complete': [StageCompleteEvent];
  
  'analyzers:start': [AnalyzersStartEvent];
  'analyzer:start': [AnalyzerStartEvent];
  'analyzer:complete': [AnalyzerCompleteEvent];
  'analyzers:complete': [AnalyzersCompleteEvent];
  
  'connection:start': [ConnectionStartEvent];
  'connection:complete': [ConnectionCompleteEvent];
  
  'builder:start': [BuilderStartEvent];
  'builder:complete': [BuilderCompleteEvent];
  
  'task:start': [TaskStartEvent];
  'task:complete': [TaskCompleteEvent];
}

/**
 * Unlocked package builder specific events
 */
export interface UnlockedBuildEvents {
  'unlocked:prune:start': [PruneStartEvent];
  'unlocked:prune:complete': [PruneCompleteEvent];
  'unlocked:create:start': [CreateStartEvent];
  'unlocked:create:progress': [CreateProgressEvent];
  'unlocked:create:complete': [CreateCompleteEvent];
  'unlocked:validation:start': [ValidationStartEvent];
  'unlocked:validation:complete': [ValidationCompleteEvent];
  'task:start': [TaskStartEvent];
  'task:complete': [TaskCompleteEvent];
}

/**
 * Source package builder specific events
 */
export interface SourceBuildEvents {
  'source:assemble:start': [SourceAssembleStartEvent];
  'source:assemble:complete': [SourceAssembleCompleteEvent];
  'source:test:start': [SourceTestStartEvent];
  'source:test:complete': [SourceTestCompleteEvent];
  'task:start': [TaskStartEvent];
  'task:complete': [TaskCompleteEvent];
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
  version: string;
  artifactPath: string;
  sourceHash: string;
  artifactHash: string;
  duration: number;
}

export interface AssemblyErrorEvent extends BaseEvent {
  version: string;
  error: Error;
}

/**
 * Artifact assembly events emitted by ArtifactAssembler
 */
export interface AssemblyEvents {
  'assembly:start': [AssemblyStartEvent];
  'assembly:pack': [AssemblyPackEvent];
  'assembly:complete': [AssemblyCompleteEvent];
  'assembly:error': [AssemblyErrorEvent];
}

/**
 * Combined event map for all build events
 */
export type AllBuildEvents = BuildEvents & UnlockedBuildEvents & SourceBuildEvents & AssemblyEvents;