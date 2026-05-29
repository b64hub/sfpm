/**
 * @module types/events
 *
 * Legacy event maps that use OLD event names for the current
 * `extends EventEmitter` pattern in builders / orchestrators.
 * These will be removed when those classes migrate to domain event buses.
 *
 * For event type definitions, import from `@b64hub/sfpm-core` or `../events/`.
 */

import type {
  AnalyzerCompleteEvent, AnalyzersCompleteEvent,
  AnalyzersStartEvent, AnalyzerStartEvent,
  ArtifactCompleteEvent, ArtifactErrorEvent, ArtifactPackEvent, ArtifactStartEvent,
  AssembleCompleteEvent, AssembleStartEvent,
  BuildCompleteEvent, BuilderCompleteEvent, BuildErrorEvent, BuilderStartEvent,
  BuildSkippedEvent, BuildStartEvent,
  CreateCompleteEvent, CreateProgressEvent, CreateStartEvent,
  PruneCompleteEvent, PruneStartEvent,
  StageCompleteEvent, StageStartEvent,
  TaskCompleteEvent, TaskSkippedEvent, TaskStartEvent,
  TaskValidationCompleteEvent, TaskValidationProgressEvent, TaskValidationStartEvent,
  ValidationCompleteEvent, ValidationStartEvent,
} from '../events/build-event-bus.js';
import type {
  ConnectionCompleteEvent, ConnectionStartEvent, HookCompleteEvent, HooksCompleteEvent, HooksStartEvent,
} from '../events/types.js';

// ============================================================================
// Legacy event maps (still used by current extends-EventEmitter classes)
// ============================================================================

/** Combined event map with OLD event names — used by PackageBuilder, SfpmCore. */
export interface AllBuildEvents {
  'analyzer:complete': [AnalyzerCompleteEvent];
  'analyzer:start': [AnalyzerStartEvent];
  'analyzers:complete': [AnalyzersCompleteEvent];
  'analyzers:start': [AnalyzersStartEvent];
  'assembly:complete': [ArtifactCompleteEvent];
  'assembly:error': [ArtifactErrorEvent];
  'assembly:pack': [ArtifactPackEvent];
  'assembly:start': [ArtifactStartEvent];
  'build:complete': [BuildCompleteEvent];
  'build:error': [BuildErrorEvent];
  'build:skipped': [BuildSkippedEvent];
  'build:start': [BuildStartEvent];
  'builder:complete': [BuilderCompleteEvent];
  'builder:start': [BuilderStartEvent];
  'connection:complete': [ConnectionCompleteEvent];
  'connection:start': [ConnectionStartEvent];
  'hook:complete': [HookCompleteEvent];
  'hooks:complete': [HooksCompleteEvent];
  'hooks:start': [HooksStartEvent];
  'source:assemble:complete': [AssembleCompleteEvent];
  'source:assemble:start': [AssembleStartEvent];
  'stage:complete': [StageCompleteEvent];
  'stage:start': [StageStartEvent];
  'task:complete': [TaskCompleteEvent];
  'task:skipped': [TaskSkippedEvent];
  'task:start': [TaskStartEvent];
  'task:validation:complete': [TaskValidationCompleteEvent];
  'task:validation:progress': [TaskValidationProgressEvent];
  'task:validation:start': [TaskValidationStartEvent];
  'unlocked:create:complete': [CreateCompleteEvent];
  'unlocked:create:progress': [CreateProgressEvent];
  'unlocked:create:start': [CreateStartEvent];
  'unlocked:prune:complete': [PruneCompleteEvent];
  'unlocked:prune:start': [PruneStartEvent];
  'unlocked:validation:complete': [ValidationCompleteEvent];
  'unlocked:validation:start': [ValidationStartEvent];
}

/** Event subset for UnlockedPackageBuilder. */
export type UnlockedBuildEvents = Pick<AllBuildEvents, 'task:complete' | 'task:skipped' | 'task:start' | 'unlocked:create:complete' | 'unlocked:create:progress' | 'unlocked:create:start' | 'unlocked:prune:complete' | 'unlocked:prune:start' | 'unlocked:validation:complete' | 'unlocked:validation:start'>;
/** Event subset for SourcePackageBuilder. */
export type SourceBuildEvents = Pick<AllBuildEvents, 'source:assemble:complete' | 'source:assemble:start' | 'task:complete' | 'task:skipped' | 'task:start' | 'task:validation:complete' | 'task:validation:progress' | 'task:validation:start'>;
/** Event subset for assembly pipeline. */
export type AssemblyEvents = Pick<AllBuildEvents, 'assembly:complete' | 'assembly:error' | 'assembly:pack' | 'assembly:start'>;
