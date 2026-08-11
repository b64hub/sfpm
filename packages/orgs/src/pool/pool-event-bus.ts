import {TypedEventEmitter} from '@b64hub/sfpm-core';

import type {PoolDeleteResult, PoolProvisionResult} from './pool-manager.js';

/**
 * Event map for `PoolManager`. Provides progress tracking during
 * the provisioning lifecycle.
 */
export interface PoolEvents {
  'pool:allocation:computed': [payload: {currentAllocation: number; remaining: number; tag: string; toAllocate: number}];
  'pool:delete:complete': [payload: PoolDeleteResult];
  'pool:delete:start': [payload: {count: number; tag: string; timestamp: Date}];
  'pool:org:created': [payload: {alias: string; index: number; timestamp: Date; total: number; username: string}];
  'pool:org:deleted': [payload: {timestamp: Date; username: string}];
  'pool:org:discarded': [payload: {reason: string; timestamp: Date; username: string}];
  'pool:org:failed': [payload: {alias: string; error: string; index: number; timedOut: boolean; timestamp: Date}];
  /** Emitted before a backoff-delayed retry of a single org creation. */
  'pool:org:retrying': [payload: {alias: string; attempt: number; error: string; maxAttempts: number; timestamp: Date}];
  'pool:org:validated': [payload: {timestamp: Date; username: string}];
  'pool:package:complete': [payload: {packageName: string; success: boolean; timestamp: Date; total: number; username: string; version?: string}];
  'pool:package:start': [payload: {packageName: string; timestamp: Date; total: number; username: string}];
  'pool:provision:complete': [payload: PoolProvisionResult];
  'pool:provision:start': [payload: {tag: string; timestamp: Date; toAllocate: number}];
  'pool:task:complete': [payload: {success: boolean; task: string; timestamp: Date; username: string}];
  'pool:task:error': [payload: {error: string; task: string; timestamp: Date; username: string}];
  'pool:task:start': [payload: {task: string; timestamp: Date; username: string}];
}

/**
 * Domain event bus for pool provisioning operations.
 *
 * Mirrors `BuildEventBus`/`InstallEventBus` in `@b64hub/sfpm-core` —
 * `PoolManager` holds one of these instead of extending `EventEmitter`
 * directly. Pool events already carry their own scoping (`tag`, `alias`,
 * `username`) in each payload, so unlike the build/install buses there's
 * no `forXxx()` scoped-sink layer here.
 */
export class PoolEventBus extends TypedEventEmitter<PoolEvents> {}
