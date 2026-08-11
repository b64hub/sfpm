import {TypedEventEmitter} from '@b64hub/sfpm-core';

/**
 * Event map for `PoolFetcher`. Provides progress tracking during
 * fetch and claim operations.
 */
export interface PoolFetcherEvents {
  'pool:fetch:claimed': [payload: {tag: string; timestamp: Date; username: string}];
  'pool:fetch:complete': [payload: {count: number; tag: string; timestamp: Date}];
  'pool:fetch:skipped': [payload: {reason: string; timestamp: Date; username: string}];
  'pool:fetch:start': [payload: {available: number; tag: string; timestamp: Date}];
}

/**
 * Domain event bus for pool fetch/claim operations.
 *
 * Mirrors `PoolEventBus`/`BuildEventBus`/`InstallEventBus` — `PoolFetcher`
 * holds one of these instead of extending `EventEmitter` directly.
 */
export class PoolFetcherEventBus extends TypedEventEmitter<PoolFetcherEvents> {}
