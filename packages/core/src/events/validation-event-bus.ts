import type {EventSink} from './event-sink.js';
import type {BaseEvent} from './types.js';

import {ScopedEventSink} from './event-sink.js';
import {TypedEventEmitter} from './typed-event-emitter.js';

// ============================================================================
// Validation Resolution Payloads (what producers pass — source of truth)
// ============================================================================

export interface ResolveStartPayload {
  packageNames: string[];
}

export interface ResolveStatusPayload {
  attempt?: number;
  status: 'in-progress' | 'polling' | 'queued';
  waitingFor?: string;
}

export interface ResolvePassedPayload {
  checks: string[];
  codeCoverage?: number;
}

export interface ResolveFailedPayload {
  codeCoverage?: number;
  error: string;
}

export interface ResolveTimeoutPayload {
  elapsedMs: number;
}

export interface ResolveCompletePayload {
  failed: number;
  passed: number;
  timedOut: number;
  total: number;
}

// ============================================================================
// Derived Event Types (Payload + BaseEvent — what listeners receive)
// ============================================================================

export type ResolveStartEvent = BaseEvent & ResolveStartPayload;
export type ResolveStatusEvent = BaseEvent & ResolveStatusPayload;
export type ResolvePassedEvent = BaseEvent & ResolvePassedPayload;
export type ResolveFailedEvent = BaseEvent & ResolveFailedPayload;
export type ResolveTimeoutEvent = BaseEvent & ResolveTimeoutPayload;
export type ResolveCompleteEvent = BaseEvent & ResolveCompletePayload;

// ============================================================================
// Event Map
// ============================================================================

export interface ValidationEvents {
  'resolve:complete': [ResolveCompleteEvent];
  'resolve:failed': [ResolveFailedEvent];
  'resolve:passed': [ResolvePassedEvent];
  'resolve:start': [ResolveStartEvent];
  'resolve:status': [ResolveStatusEvent];
  'resolve:timeout': [ResolveTimeoutEvent];
}

// ============================================================================
// ValidationEventSink — write-only interface with convenience methods
// ============================================================================

export interface ValidationEventSink extends EventSink<ValidationEvents> {
  complete(payload: ResolveCompletePayload): void;
  failed(payload: ResolveFailedPayload): void;
  passed(payload: ResolvePassedPayload): void;
  start(payload: ResolveStartPayload): void;
  status(payload: ResolveStatusPayload): void;
  timeout(payload: ResolveTimeoutPayload): void;
}

// ============================================================================
// ScopedValidationSink — scoped write-only sink with convenience methods
// ============================================================================

export class ScopedValidationSink extends ScopedEventSink<ValidationEvents> implements ValidationEventSink {
  complete(p: ResolveCompletePayload): void {
    this.emit('resolve:complete', p as any);
  }

  failed(p: ResolveFailedPayload): void {
    this.emit('resolve:failed', p as any);
  }

  passed(p: ResolvePassedPayload): void {
    this.emit('resolve:passed', p as any);
  }

  start(p: ResolveStartPayload): void {
    this.emit('resolve:start', p as any);
  }

  status(p: ResolveStatusPayload): void {
    this.emit('resolve:status', p as any);
  }

  timeout(p: ResolveTimeoutPayload): void {
    this.emit('resolve:timeout', p as any);
  }
}

// ============================================================================
// ValidationEventBus
// ============================================================================

/**
 * Domain event bus for post-build validation resolution.
 *
 * Carries events for the async polling phase where pending validations
 * (deploy results, package version requests) are resolved to pass/fail.
 *
 * The bus exposes typed convenience methods matching the sink interface,
 * so callers can emit events directly without constructing a sink.
 * Use {@link forPackage} to create a {@link ScopedValidationSink}
 * that auto-injects `packageName`.
 */
export class ValidationEventBus extends TypedEventEmitter<ValidationEvents> implements ValidationEventSink {
  /** Create a write-only sink that can be passed to producers. */
  asSink(): ValidationEventSink {
    return new ScopedValidationSink(this, '');
  }

  complete(p: ResolveCompletePayload): void {
    this.emit('resolve:complete', p as any);
  }

  failed(p: ResolveFailedPayload): void {
    this.emit('resolve:failed', p as any);
  }

  /** Create a write-only sink scoped to a single package. */
  forPackage(packageName: string): ScopedValidationSink {
    return new ScopedValidationSink(this, packageName);
  }

  passed(p: ResolvePassedPayload): void {
    this.emit('resolve:passed', p as any);
  }

  start(p: ResolveStartPayload): void {
    this.emit('resolve:start', p as any);
  }

  status(p: ResolveStatusPayload): void {
    this.emit('resolve:status', p as any);
  }

  timeout(p: ResolveTimeoutPayload): void {
    this.emit('resolve:timeout', p as any);
  }
}
