
// ============================================================================
// Base Event
// ============================================================================

/**
 * Fields auto-injected by the event bus infrastructure.
 * `timestamp` is injected by {@link TypedEventEmitter}.
 * `packageName` is injected by {@link ScopedEventSink} via `forPackage()`.
 *
 * Producers pass only the payload; listeners receive `Payload & BaseEvent`.
 */
export interface BaseEvent {
  packageName: string;
  timestamp: Date;
}

// ============================================================================
// Shared Payloads (what producers pass — source of truth)
// ============================================================================

export interface ConnectionStartPayload {
  orgType: 'devhub' | 'production' | 'sandbox';
  username: string;
}

export interface ConnectionCompletePayload {
  orgId?: string;
  username: string;
}

export interface HooksStartPayload {
  hookCount: number;
  hookNames: string[];
  operation: string;
  timing: string;
}

export interface HookCompletePayload {
  hookName: string;
  operation: string;
  timing: string;
}

export interface HooksCompletePayload {
  completedCount: number;
  operation: string;
  timing: string;
}

// ============================================================================
// Shared Events (derived — what listeners receive)
// ============================================================================

export type ConnectionStartEvent = BaseEvent & ConnectionStartPayload;
export type ConnectionCompleteEvent = BaseEvent & ConnectionCompletePayload;
export type HooksStartEvent = BaseEvent & HooksStartPayload;
export type HookCompleteEvent = BaseEvent & HookCompletePayload;
export type HooksCompleteEvent = BaseEvent & HooksCompletePayload;

// ============================================================================
// Shared Event Maps (mixed into domain-specific maps)
// ============================================================================

/** Connection events shared across build and install domains. */
export interface ConnectionEvents {
  'connection:complete': [ConnectionCompleteEvent];
  'connection:start': [ConnectionStartEvent];
}

/** Hook events shared across build and install domains. */
export interface HookEvents {
  'hook:complete': [HookCompleteEvent];
  'hooks:complete': [HooksCompleteEvent];
  'hooks:start': [HooksStartEvent];
}

// ============================================================================
// Re-exports for convenience
// ============================================================================

export {PackageType} from '../types/package.js';

// ============================================================================
// Hook Event Sink (used by LifecycleEngine — satisfied by both ScopedBuildSink and ScopedInstallSink)
// ============================================================================

/**
 * Minimal write-only contract for emitting hook lifecycle events.
 * Both {@link ScopedBuildSink} and {@link ScopedInstallSink} implement this
 * since hook events are shared across build and install domains.
 */
export interface HookEventSink {
  hookComplete(payload: HookCompletePayload): void;
  hooksComplete(payload: HooksCompletePayload): void;
  hooksStart(payload: HooksStartPayload): void;
}
