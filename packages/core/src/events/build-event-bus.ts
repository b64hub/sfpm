import type {EventSink} from './event-sink.js';
import type {
  BaseEvent,
  ConnectionCompletePayload,
  ConnectionEvents,
  ConnectionStartPayload,
  HookCompletePayload,
  HookEvents,
  HooksCompletePayload,
  HooksStartPayload,
} from './types.js';

import {ScopedEventSink} from './event-sink.js';
import {TypedEventEmitter} from './typed-event-emitter.js';
import {PackageType} from './types.js';

// ============================================================================
// Build Lifecycle Payloads (what producers pass — source of truth)
// ============================================================================

export interface BuildStartPayload {
  buildNumber?: string;
  packageType: PackageType;
  version?: string;
}

export interface BuildCompletePayload {
  artifactPath?: string;
  packageVersionId?: string;
  reason?: string;
  skipped?: boolean;
  success: boolean;
}

export interface BuildSkippedPayload {
  artifactPath?: string;
  latestVersion?: string;
  packageType: PackageType;
  reason: 'already-built' | 'empty-package' | 'no-changes';
  sourceHash?: string;
  version?: string;
}

export interface BuildErrorPayload {
  error: Error;
  phase: 'analysis' | 'build' | 'connection' | 'post-build' | 'staging';
}

// ============================================================================
// Staging Payloads
// ============================================================================

export interface StageStartPayload {
  stagingDirectory?: string;
}

export interface StageCompletePayload {
  componentCount: number;
  stagingDirectory: string;
}

// ============================================================================
// Analyzer Payloads
// ============================================================================

export interface AnalyzersStartPayload {
  analyzerCount: number;
}

export interface AnalyzerStartPayload {
  analyzerName: string;
}

export interface AnalyzerCompletePayload {
  analyzerName: string;
  error?: string;
  findings?: Record<string, any>;
}

export interface AnalyzersCompletePayload {
  completedCount: number;
}

// ============================================================================
// Builder Execution Payloads
// ============================================================================

export interface BuilderStartPayload {
  builderName: string;
  packageType: PackageType;
}

export interface BuilderCompletePayload {
  builderName: string;
  packageType: PackageType;
}

// ============================================================================
// Unlocked Package Payloads
// ============================================================================

export interface PruneStartPayload {
  reason: string;
}

export interface PruneCompletePayload {
  prunedFiles: number;
}

export interface CreateStartPayload {
  packageId?: string;
  versionNumber: string;
}

export interface CreateProgressPayload {
  message?: string;
  percentComplete?: number;
  status: string;
}

export interface CreateCompletePayload {
  codeCoverage?: null | number;
  createdDate?: string;
  hasMetadataRemoved?: boolean;
  hasPassedCodeCoverageCheck?: boolean;
  packageId?: string;
  packageVersionCreateRequestId?: string;
  packageVersionId: string;
  status?: string;
  subscriberPackageVersionId?: string;
  totalNumberOfMetadataFiles?: number;
  totalSizeOfMetadataFiles?: number;
  versionNumber: string;
}

export interface ValidationStartPayload {
  validationType: 'apex' | 'dependencies' | 'metadata';
}

export interface ValidationCompletePayload {
  details?: string;
  passed: boolean;
  validationType: 'apex' | 'dependencies' | 'metadata';
}

// ============================================================================
// Source Package Payloads
// ============================================================================

export interface AssembleStartPayload {
  sourcePath: string;
}

export interface AssembleCompletePayload {
  artifactPath: string;
  sourcePath: string;
}

// ============================================================================
// Task Payloads
// ============================================================================

export interface TaskStartPayload {
  taskName: string;
  taskType: 'post-build' | 'pre-build';
}

export interface TaskCompletePayload {
  success: boolean;
  taskName: string;
  taskType: 'post-build' | 'pre-build';
}

export interface TaskSkippedPayload {
  reason: string;
  taskName: string;
  taskType: 'post-build' | 'pre-build';
}

export interface TaskValidationStartPayload {
  testCount: number;
  testLevel?: string;
}

export interface TaskValidationProgressPayload {
  methodsCompleted?: number;
  methodsTotal?: number;
  status: string;
}

export interface TaskValidationCompletePayload {
  coveragePercentage?: number;
  coverageRequired?: number;
  failed: number;
  passed: number;
  testCount: number;
}

// ============================================================================
// Artifact Payloads
// ============================================================================

export interface ArtifactStartPayload {
  version: string;
}

export interface ArtifactPackPayload {
  tarballName: string;
}

export interface ArtifactCompletePayload {
  artifactHash: string;
  artifactPath: string;
  duration: number;
  sourceHash: string;
  version: string;
}

export interface ArtifactErrorPayload {
  error: Error;
  version: string;
}

// ============================================================================
// Derived Event Types (what listeners receive = Payload & BaseEvent)
// ============================================================================

export type BuildStartEvent = BaseEvent & BuildStartPayload;
export type BuildCompleteEvent = BaseEvent & BuildCompletePayload;
export type BuildSkippedEvent = BaseEvent & BuildSkippedPayload;
export type BuildErrorEvent = BaseEvent & BuildErrorPayload;
export type StageStartEvent = BaseEvent & StageStartPayload;
export type StageCompleteEvent = BaseEvent & StageCompletePayload;
export type AnalyzersStartEvent = AnalyzersStartPayload & BaseEvent;
export type AnalyzerStartEvent = AnalyzerStartPayload & BaseEvent;
export type AnalyzerCompleteEvent = AnalyzerCompletePayload & BaseEvent;
export type AnalyzersCompleteEvent = AnalyzersCompletePayload & BaseEvent;
export type BuilderStartEvent = BaseEvent & BuilderStartPayload;
export type BuilderCompleteEvent = BaseEvent & BuilderCompletePayload;
export type PruneStartEvent = BaseEvent & PruneStartPayload;
export type PruneCompleteEvent = BaseEvent & PruneCompletePayload;
export type CreateStartEvent = BaseEvent & CreateStartPayload;
export type CreateProgressEvent = BaseEvent & CreateProgressPayload;
export type CreateCompleteEvent = BaseEvent & CreateCompletePayload;
export type ValidationStartEvent = BaseEvent & ValidationStartPayload;
export type ValidationCompleteEvent = BaseEvent & ValidationCompletePayload;
export type AssembleStartEvent = AssembleStartPayload & BaseEvent;
export type AssembleCompleteEvent = AssembleCompletePayload & BaseEvent;
export type TaskStartEvent = BaseEvent & TaskStartPayload;
export type TaskCompleteEvent = BaseEvent & TaskCompletePayload;
export type TaskSkippedEvent = BaseEvent & TaskSkippedPayload;
export type TaskValidationStartEvent = BaseEvent & TaskValidationStartPayload;
export type TaskValidationProgressEvent = BaseEvent & TaskValidationProgressPayload;
export type TaskValidationCompleteEvent = BaseEvent & TaskValidationCompletePayload;
export type ArtifactStartEvent = ArtifactStartPayload & BaseEvent;
export type ArtifactPackEvent = ArtifactPackPayload & BaseEvent;
export type ArtifactCompleteEvent = ArtifactCompletePayload & BaseEvent;
export type ArtifactErrorEvent = ArtifactErrorPayload & BaseEvent;

// ============================================================================
// Build Event Map
// ============================================================================

/**
 * Consolidated event map for all build-related events.
 *
 * Uses a type intersection (not `interface extends`) so that TypeScript
 * preserves the implicit index signature required by `TypedEventEmitter`.
 */
export type BuildEvents = ConnectionEvents & HookEvents & {
  'analyzer:complete': [AnalyzerCompleteEvent];
  'analyzer:start': [AnalyzerStartEvent];
  'analyzers:complete': [AnalyzersCompleteEvent];
  'analyzers:start': [AnalyzersStartEvent];
  'artifact:complete': [ArtifactCompleteEvent];
  'artifact:error': [ArtifactErrorEvent];
  'artifact:pack': [ArtifactPackEvent];
  'artifact:start': [ArtifactStartEvent];
  'assemble:complete': [AssembleCompleteEvent];
  'assemble:start': [AssembleStartEvent];
  'builder:complete': [BuilderCompleteEvent];
  'builder:start': [BuilderStartEvent];
  complete: [BuildCompleteEvent];
  'create:complete': [CreateCompleteEvent];
  'create:progress': [CreateProgressEvent];
  'create:start': [CreateStartEvent];
  error: [BuildErrorEvent];
  'prune:complete': [PruneCompleteEvent];
  'prune:start': [PruneStartEvent];
  skip: [BuildSkippedEvent];
  'stage:complete': [StageCompleteEvent];
  'stage:start': [StageStartEvent];
  start: [BuildStartEvent];
  'task:complete': [TaskCompleteEvent];
  'task:skip': [TaskSkippedEvent];
  'task:start': [TaskStartEvent];
  'task:validate:complete': [TaskValidationCompleteEvent];
  'task:validate:progress': [TaskValidationProgressEvent];
  'task:validate:start': [TaskValidationStartEvent];
  'validate:complete': [ValidationCompleteEvent];
  'validate:start': [ValidationStartEvent];
};

// ============================================================================
// BuildEventSink — write-only interface with convenience methods
// ============================================================================

/**
 * Write-only event sink for build producers (builders, assemblers).
 *
 * Convenience methods accept Payload types (source of truth).
 * Base fields (`packageName`, `timestamp`) are auto-injected by the bus.
 */
export interface BuildEventSink extends EventSink<BuildEvents> {
  analyzerComplete(payload: AnalyzerCompletePayload): void;
  analyzersComplete(payload: AnalyzersCompletePayload): void;
  analyzersStart(payload: AnalyzersStartPayload): void;
  analyzerStart(payload: AnalyzerStartPayload): void;
  artifactComplete(payload: ArtifactCompletePayload): void;
  artifactError(payload: ArtifactErrorPayload): void;
  artifactPack(payload: ArtifactPackPayload): void;
  artifactStart(payload: ArtifactStartPayload): void;
  assembleComplete(payload: AssembleCompletePayload): void;
  assembleStart(payload: AssembleStartPayload): void;
  builderComplete(payload: BuilderCompletePayload): void;
  builderStart(payload: BuilderStartPayload): void;
  complete(payload: BuildCompletePayload): void;
  connectionComplete(payload: ConnectionCompletePayload): void;
  connectionStart(payload: ConnectionStartPayload): void;
  createComplete(payload: CreateCompletePayload): void;
  createProgress(payload: CreateProgressPayload): void;
  createStart(payload: CreateStartPayload): void;
  error(payload: BuildErrorPayload): void;
  hookComplete(payload: HookCompletePayload): void;
  hooksComplete(payload: HooksCompletePayload): void;
  hooksStart(payload: HooksStartPayload): void;
  pruneComplete(payload: PruneCompletePayload): void;
  pruneStart(payload: PruneStartPayload): void;
  skip(payload: BuildSkippedPayload): void;
  stageComplete(payload: StageCompletePayload): void;
  stageStart(payload: StageStartPayload): void;
  start(payload: BuildStartPayload): void;
  taskComplete(payload: TaskCompletePayload): void;
  taskSkip(payload: TaskSkippedPayload): void;
  taskStart(payload: TaskStartPayload): void;
  taskValidateComplete(payload: TaskValidationCompletePayload): void;
  taskValidateProgress(payload: TaskValidationProgressPayload): void;
  taskValidateStart(payload: TaskValidationStartPayload): void;
  validateComplete(payload: ValidationCompletePayload): void;
  validateStart(payload: ValidationStartPayload): void;
}

// ============================================================================
// ScopedBuildSink — scoped write-only sink with convenience methods
// ============================================================================

/**
 * Package-scoped event sink with typed convenience methods.
 * Created via {@link BuildEventBus.forPackage}.
 */
export class ScopedBuildSink extends ScopedEventSink<BuildEvents> implements BuildEventSink {
  analyzerComplete(p: AnalyzerCompletePayload): void {
    this.emit('analyzer:complete', p as any);
  }

  analyzersComplete(p: AnalyzersCompletePayload): void {
    this.emit('analyzers:complete', p as any);
  }

  analyzersStart(p: AnalyzersStartPayload): void {
    this.emit('analyzers:start', p as any);
  }

  analyzerStart(p: AnalyzerStartPayload): void {
    this.emit('analyzer:start', p as any);
  }

  artifactComplete(p: ArtifactCompletePayload): void {
    this.emit('artifact:complete', p as any);
  }

  artifactError(p: ArtifactErrorPayload): void {
    this.emit('artifact:error', p as any);
  }

  artifactPack(p: ArtifactPackPayload): void {
    this.emit('artifact:pack', p as any);
  }

  artifactStart(p: ArtifactStartPayload): void {
    this.emit('artifact:start', p as any);
  }

  assembleComplete(p: AssembleCompletePayload): void {
    this.emit('assemble:complete', p as any);
  }

  assembleStart(p: AssembleStartPayload): void {
    this.emit('assemble:start', p as any);
  }

  builderComplete(p: BuilderCompletePayload): void {
    this.emit('builder:complete', p as any);
  }

  builderStart(p: BuilderStartPayload): void {
    this.emit('builder:start', p as any);
  }

  complete(p: BuildCompletePayload): void {
    this.emit('complete', p as any);
  }

  connectionComplete(p: ConnectionCompletePayload): void {
    this.emit('connection:complete', p as any);
  }

  connectionStart(p: ConnectionStartPayload): void {
    this.emit('connection:start', p as any);
  }

  createComplete(p: CreateCompletePayload): void {
    this.emit('create:complete', p as any);
  }

  createProgress(p: CreateProgressPayload): void {
    this.emit('create:progress', p as any);
  }

  createStart(p: CreateStartPayload): void {
    this.emit('create:start', p as any);
  }

  error(p: BuildErrorPayload): void {
    this.emit('error', p as any);
  }

  hookComplete(p: HookCompletePayload): void {
    this.emit('hook:complete', p as any);
  }

  hooksComplete(p: HooksCompletePayload): void {
    this.emit('hooks:complete', p as any);
  }

  hooksStart(p: HooksStartPayload): void {
    this.emit('hooks:start', p as any);
  }

  pruneComplete(p: PruneCompletePayload): void {
    this.emit('prune:complete', p as any);
  }

  pruneStart(p: PruneStartPayload): void {
    this.emit('prune:start', p as any);
  }

  skip(p: BuildSkippedPayload): void {
    this.emit('skip', p as any);
  }

  stageComplete(p: StageCompletePayload): void {
    this.emit('stage:complete', p as any);
  }

  stageStart(p: StageStartPayload): void {
    this.emit('stage:start', p as any);
  }

  start(p: BuildStartPayload): void {
    this.emit('start', p as any);
  }

  taskComplete(p: TaskCompletePayload): void {
    this.emit('task:complete', p as any);
  }

  taskSkip(p: TaskSkippedPayload): void {
    this.emit('task:skip', p as any);
  }

  taskStart(p: TaskStartPayload): void {
    this.emit('task:start', p as any);
  }

  taskValidateComplete(p: TaskValidationCompletePayload): void {
    this.emit('task:validate:complete', p as any);
  }

  taskValidateProgress(p: TaskValidationProgressPayload): void {
    this.emit('task:validate:progress', p as any);
  }

  taskValidateStart(p: TaskValidationStartPayload): void {
    this.emit('task:validate:start', p as any);
  }

  validateComplete(p: ValidationCompletePayload): void {
    this.emit('validate:complete', p as any);
  }

  validateStart(p: ValidationStartPayload): void {
    this.emit('validate:start', p as any);
  }
}

// ============================================================================
// BuildEventBus
// ============================================================================

/**
 * Domain event bus for build operations.
 *
 * Carries all build-related events: lifecycle, staging, analysis,
 * connection, builder execution, unlocked/source-specific, assembly,
 * task, and hook events.
 *
 * Use {@link forPackage} to create a {@link ScopedBuildSink}
 * that auto-injects `packageName` and provides convenience methods.
 */
export class BuildEventBus extends TypedEventEmitter<BuildEvents> {
  /** Create a write-only sink scoped to a single package. */
  forPackage(packageName: string): ScopedBuildSink {
    return new ScopedBuildSink(this, packageName);
  }
}
