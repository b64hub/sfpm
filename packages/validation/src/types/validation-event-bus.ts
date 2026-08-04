import type {EventSink} from '@b64hub/sfpm-core';

import {ScopedEventSink, TypedEventEmitter} from '@b64hub/sfpm-core';

import type {AvailabilityResult, ValidationCapability, ValidationResult} from './validator.js';

// ============================================================================
// Payloads (what producers pass — source of truth)
// ============================================================================

export interface ValidatorAvailabilityPayload {
  availability: AvailabilityResult;
  packageId: string;
  validator: string;
}

export interface ValidatorStartPayload {
  capability: ValidationCapability;
  packageId: string;
  validator: string;
}

export interface ValidatorProgressPayload {
  message: string;
  packageId: string;
  validator: string;
}

export interface ValidatorCompletePayload {
  packageId: string;
  result: ValidationResult;
  validator: string;
}

export interface ValidatorErrorPayload {
  message: string;
  packageId: string;
  validator: string;
}

export interface NimbusDaemonUnavailablePayload {
  reason: string;
}

// ============================================================================
// Event Map
// ============================================================================
//
// Each entry is a one-element tuple so TypedEventEmitter's spread signature
// accepts a single payload argument. TypedEventEmitter.enrichPayload
// auto-injects { timestamp } and ScopedEventSink injects { packageName }
// at runtime — neither appears in the payload types here.

export type NimbusValidationEvents = {
  'nimbus:binary-resolving': [Record<string, never>];
  'nimbus:daemon-started': [Record<string, never>];
  'nimbus:daemon-starting': [Record<string, never>];
  'nimbus:daemon-stopped': [Record<string, never>];
  'nimbus:daemon-unavailable': [NimbusDaemonUnavailablePayload];
  'validator:availability': [ValidatorAvailabilityPayload];
  'validator:complete': [ValidatorCompletePayload];
  'validator:error': [ValidatorErrorPayload];
  'validator:progress': [ValidatorProgressPayload];
  'validator:start': [ValidatorStartPayload];
};

/**
 * Write-only event bus type for Nimbus validation producers.
 * Structurally compatible with any object exposing `emit` — use
 * {@link NimbusValidationEventBus} for the full implementation.
 */
export type ValidationEventBus = EventSink<NimbusValidationEvents>;

// ============================================================================
// ValidationEventSink — write-only interface with convenience methods
// ============================================================================

/**
 * Write-only event sink for Nimbus validation producers.
 *
 * Convenience methods accept Payload types (source of truth).
 * Base fields (`packageName`, `timestamp`) are auto-injected by the bus.
 * Use {@link NimbusValidationEventBus.forPackage} to create a
 * {@link ScopedValidationSink} pre-bound to a single package.
 */
export interface ValidationEventSink extends EventSink<NimbusValidationEvents> {
  nimbusBinaryResolving(): void;
  nimbusDaemonStarted(): void;
  nimbusDaemonStarting(): void;
  nimbusDaemonStopped(): void;
  nimbusDaemonUnavailable(payload: NimbusDaemonUnavailablePayload): void;
  validatorAvailability(payload: ValidatorAvailabilityPayload): void;
  validatorComplete(payload: ValidatorCompletePayload): void;
  validatorError(payload: ValidatorErrorPayload): void;
  validatorProgress(payload: ValidatorProgressPayload): void;
  validatorStart(payload: ValidatorStartPayload): void;
}

// ============================================================================
// ScopedValidationSink
// ============================================================================

/**
 * Package-scoped event sink with typed convenience methods.
 * Created via {@link NimbusValidationEventBus.forPackage}.
 */
export class ScopedValidationSink extends ScopedEventSink<NimbusValidationEvents> implements ValidationEventSink {
  nimbusBinaryResolving(): void {
    this.emit('nimbus:binary-resolving', {} as any);
  }

  nimbusDaemonStarted(): void {
    this.emit('nimbus:daemon-started', {} as any);
  }

  nimbusDaemonStarting(): void {
    this.emit('nimbus:daemon-starting', {} as any);
  }

  nimbusDaemonStopped(): void {
    this.emit('nimbus:daemon-stopped', {} as any);
  }

  nimbusDaemonUnavailable(p: NimbusDaemonUnavailablePayload): void {
    this.emit('nimbus:daemon-unavailable', p as any);
  }

  validatorAvailability(p: ValidatorAvailabilityPayload): void {
    this.emit('validator:availability', p as any);
  }

  validatorComplete(p: ValidatorCompletePayload): void {
    this.emit('validator:complete', p as any);
  }

  validatorError(p: ValidatorErrorPayload): void {
    this.emit('validator:error', p as any);
  }

  validatorProgress(p: ValidatorProgressPayload): void {
    this.emit('validator:progress', p as any);
  }

  validatorStart(p: ValidatorStartPayload): void {
    this.emit('validator:start', p as any);
  }
}

// ============================================================================
// NimbusValidationEventBus
// ============================================================================

/**
 * Domain event bus for Nimbus-backed validation runs.
 *
 * Carries events for validator lifecycle, result reporting, and
 * Nimbus daemon management. Use {@link forPackage} to create a
 * {@link ScopedValidationSink} with typed convenience methods
 * pre-bound to a single package.
 */
export class NimbusValidationEventBus extends TypedEventEmitter<NimbusValidationEvents> {
  /** Create a write-only sink scoped to a single package. */
  forPackage(packageName: string): ScopedValidationSink {
    return new ScopedValidationSink(this, packageName);
  }
}
