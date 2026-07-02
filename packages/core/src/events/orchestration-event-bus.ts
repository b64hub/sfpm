import {TypedEventEmitter} from './typed-event-emitter.js';

// ============================================================================
// Orchestration Base
// ============================================================================

/**
 * Base shape for orchestration events.
 * Unlike domain events (build/install), orchestration events carry
 * `orchestrationId` instead of `packageName`.
 * Both `orchestrationId` and `timestamp` are auto-injected by the bus.
 */
export interface OrchestrationBaseEvent {
  orchestrationId: string;
  timestamp: Date;
}

// ============================================================================
// Package Result
// ============================================================================

/** Result of a single package build/install within an orchestration run. */
export interface PackageResult<TResult> {
  duration: number;
  error?: string;
  packageName: string;
  result?: TResult;
  skipped: boolean;
  success: boolean;
}

/** Aggregated result of a multi-package orchestration run. */
export interface OrchestrationResult<TResult> {
  duration: number;
  failedPackages: string[];
  results: PackageResult<TResult>[];
  skippedPackages: string[];
  success: boolean;
}

// ============================================================================
// Orchestration Payloads (what producers pass — source of truth)
// ============================================================================

export interface OrchestrationStartPayload {
  includeDependencies: boolean;
  levels: string[][];
  packageNames: string[];
  totalLevels: number;
  totalPackages: number;
}

export interface OrchestrationLevelStartPayload {
  level: number;
  packageDetails: Array<{isManaged: boolean; name: string; version?: string}>;
  packages: string[];
}

export interface OrchestrationPackageCompletePayload {
  duration: number;
  error?: string;
  level: number;
  packageName: string;
  skipped: boolean;
  success: boolean;
}

export interface OrchestrationLevelCompletePayload {
  failed: string[];
  level: number;
  skipped: string[];
  succeeded: string[];
}

export interface OrchestrationCompletePayload<TResult> {
  results: PackageResult<TResult>[];
  totalDuration: number;
}

export interface OrchestrationErrorPayload {
  error: Error;
  packageName?: string;
}

// ============================================================================
// Derived Event Types (what listeners receive = Payload & OrchestrationBaseEvent)
// ============================================================================

export type OrchestrationStartEvent = OrchestrationBaseEvent & OrchestrationStartPayload;
export type OrchestrationLevelStartEvent = OrchestrationBaseEvent & OrchestrationLevelStartPayload;
export type OrchestrationPackageCompleteEvent = OrchestrationBaseEvent & OrchestrationPackageCompletePayload;
export type OrchestrationLevelCompleteEvent = OrchestrationBaseEvent & OrchestrationLevelCompletePayload;
export type OrchestrationCompleteEvent<TResult> = OrchestrationBaseEvent & OrchestrationCompletePayload<TResult>;
export type OrchestrationErrorEvent = OrchestrationBaseEvent & OrchestrationErrorPayload;

// ============================================================================
// Orchestration Event Map
// ============================================================================

export interface OrchestrationEvents<TResult> {
  complete: [OrchestrationCompleteEvent<TResult>];
  error: [OrchestrationErrorEvent];
  'level:complete': [OrchestrationLevelCompleteEvent];
  'level:start': [OrchestrationLevelStartEvent];
  'package:complete': [OrchestrationPackageCompleteEvent];
  start: [OrchestrationStartEvent];
}

// ============================================================================
// OrchestrationEventBus
// ============================================================================

/**
 * Domain event bus for orchestration-level events.
 *
 * Auto-injects both `timestamp` (from base) and `orchestrationId`
 * (set at construction) into every emitted event payload.
 *
 * Convenience methods accept Payload types (source of truth).
 */
export class OrchestrationEventBus<TResult> extends TypedEventEmitter<OrchestrationEvents<TResult>> {
  private readonly orchestrationId: string;

  constructor(orchestrationId: string) {
    super();
    this.orchestrationId = orchestrationId;
  }

  // Convenience methods
  complete(p: OrchestrationCompletePayload<TResult>): void {
    this.emit('complete', p as any);
  }

  protected override enrichPayload(args: unknown[]): unknown[] {
    const base = super.enrichPayload(args);

    const first = base[0];
    if (first !== null && typeof first === 'object' && !Array.isArray(first)) {
      return [{orchestrationId: this.orchestrationId, ...first as Record<string, unknown>}, ...base.slice(1)];
    }

    return base;
  }

  error(p: OrchestrationErrorPayload): void {
    this.emit('error', p as any);
  }

  /** Return the orchestration ID associated with this bus. */
  getOrchestrationId(): string {
    return this.orchestrationId;
  }

  levelComplete(p: OrchestrationLevelCompletePayload): void {
    this.emit('level:complete', p as any);
  }

  levelStart(p: OrchestrationLevelStartPayload): void {
    this.emit('level:start', p as any);
  }

  packageComplete(p: OrchestrationPackageCompletePayload): void {
    this.emit('package:complete', p as any);
  }

  start(p: OrchestrationStartPayload): void {
    this.emit('start', p as any);
  }
}
