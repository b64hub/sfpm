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
// Install Lifecycle Payloads (what producers pass — source of truth)
// ============================================================================

export interface InstallStartPayload {
  installReason?: string;
  packageType: PackageType;
  packageVersionId?: string;
  source?: string;
  targetOrg: string;
  versionNumber?: string;
}

export interface InstallSkipPayload {
  packageType: PackageType;
  reason: string;
  targetOrg: string;
}

export interface InstallCompletePayload {
  packageType: PackageType;
  packageVersionId?: string;
  source?: string;
  success: boolean;
  targetOrg: string;
  versionNumber?: string;
}

export interface InstallErrorPayload {
  error: string;
  packageType: PackageType;
  packageVersionId?: string;
  targetOrg: string;
  versionNumber?: string;
}

// ============================================================================
// Deployment Payloads (source deploy)
// ============================================================================

export interface DeployStartPayload {
  targetOrg: string;
}

export interface DeployProgressPayload {
  numberComponentsDeployed?: number;
  numberComponentsTotal?: number;
  status: string;
}

export interface DeployCompletePayload {
  numberComponentsDeployed?: number;
  targetOrg: string;
}

// ============================================================================
// Version Install Payloads (package version install)
// ============================================================================

export interface VersionStartPayload {
  packageVersionId: string;
}

export interface VersionProgressPayload {
  status: string;
}

export interface VersionCompletePayload {
  packageVersionId: string;
}

// ============================================================================
// Derived Event Types (what listeners receive = Payload & BaseEvent)
// ============================================================================

export type InstallStartEvent = BaseEvent & InstallStartPayload;
export type InstallSkipEvent = BaseEvent & InstallSkipPayload;
export type InstallCompleteEvent = BaseEvent & InstallCompletePayload;
export type InstallErrorEvent = BaseEvent & InstallErrorPayload;
export type DeployStartEvent = BaseEvent & DeployStartPayload;
export type DeployProgressEvent = BaseEvent & DeployProgressPayload;
export type DeployCompleteEvent = BaseEvent & DeployCompletePayload;
export type VersionStartEvent = BaseEvent & VersionStartPayload;
export type VersionProgressEvent = BaseEvent & VersionProgressPayload;
export type VersionCompleteEvent = BaseEvent & VersionCompletePayload;

// ============================================================================
// Install Event Map
// ============================================================================

/**
 * Consolidated event map for all install-related events.
 *
 * Uses a type intersection (not `interface extends`) so that TypeScript
 * preserves the implicit index signature required by `TypedEventEmitter`.
 */
export type InstallEvents = ConnectionEvents & HookEvents & {
  complete: [InstallCompleteEvent];
  'deploy:complete': [DeployCompleteEvent];
  'deploy:progress': [DeployProgressEvent];
  'deploy:start': [DeployStartEvent];
  error: [InstallErrorEvent];
  skip: [InstallSkipEvent];
  start: [InstallStartEvent];
  'version:complete': [VersionCompleteEvent];
  'version:progress': [VersionProgressEvent];
  'version:start': [VersionStartEvent];
};

// ============================================================================
// InstallEventSink — write-only interface with convenience methods
// ============================================================================

/**
 * Write-only event sink for install producers (installers).
 *
 * Convenience methods accept Payload types (source of truth).
 * Base fields (`packageName`, `timestamp`) are auto-injected by the bus.
 */
export interface InstallEventSink extends EventSink<InstallEvents> {
  complete(payload: InstallCompletePayload): void;
  connectionComplete(payload: ConnectionCompletePayload): void;
  connectionStart(payload: ConnectionStartPayload): void;
  deployComplete(payload: DeployCompletePayload): void;
  deployProgress(payload: DeployProgressPayload): void;
  deployStart(payload: DeployStartPayload): void;
  error(payload: InstallErrorPayload): void;
  hookComplete(payload: HookCompletePayload): void;
  hooksComplete(payload: HooksCompletePayload): void;
  hooksStart(payload: HooksStartPayload): void;
  skip(payload: InstallSkipPayload): void;
  start(payload: InstallStartPayload): void;
  versionComplete(payload: VersionCompletePayload): void;
  versionProgress(payload: VersionProgressPayload): void;
  versionStart(payload: VersionStartPayload): void;
}

// ============================================================================
// ScopedInstallSink
// ============================================================================

/**
 * Package-scoped event sink with typed convenience methods.
 * Created via {@link InstallEventBus.forPackage}.
 */
export class ScopedInstallSink extends ScopedEventSink<InstallEvents> implements InstallEventSink {
  complete(p: InstallCompletePayload): void {
    this.emit('complete', p as any);
  }

  connectionComplete(p: ConnectionCompletePayload): void {
    this.emit('connection:complete', p as any);
  }

  connectionStart(p: ConnectionStartPayload): void {
    this.emit('connection:start', p as any);
  }

  deployComplete(p: DeployCompletePayload): void {
    this.emit('deploy:complete', p as any);
  }

  deployProgress(p: DeployProgressPayload): void {
    this.emit('deploy:progress', p as any);
  }

  deployStart(p: DeployStartPayload): void {
    this.emit('deploy:start', p as any);
  }

  error(p: InstallErrorPayload): void {
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

  skip(p: InstallSkipPayload): void {
    this.emit('skip', p as any);
  }

  start(p: InstallStartPayload): void {
    this.emit('start', p as any);
  }

  versionComplete(p: VersionCompletePayload): void {
    this.emit('version:complete', p as any);
  }

  versionProgress(p: VersionProgressPayload): void {
    this.emit('version:progress', p as any);
  }

  versionStart(p: VersionStartPayload): void {
    this.emit('version:start', p as any);
  }
}

// ============================================================================
// InstallEventBus
// ============================================================================

/**
 * Domain event bus for install operations.
 *
 * Carries all install-related events: lifecycle, deployment,
 * version install, connection, and hook events.
 *
 * Use {@link forPackage} to create a {@link ScopedInstallSink}
 * that auto-injects `packageName` and provides convenience methods.
 */
export class InstallEventBus extends TypedEventEmitter<InstallEvents> {
  /** Create a write-only sink scoped to a single package. */
  forPackage(packageName: string): ScopedInstallSink {
    return new ScopedInstallSink(this, packageName);
  }
}
