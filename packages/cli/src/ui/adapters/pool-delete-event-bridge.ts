import type {PoolEventBus} from '@b64hub/sfpm-orgs';
import type EventEmitter from 'node:events';

/**
 * Bridges PoolManager delete events onto the PoolDeleteApp's uiBus.
 *
 * `delete:start`/`delete:done` are emitted directly by the CLI around the
 * `manager.delete()` call (see `PoolDelete.deleteTag()`) rather than from
 * here, because the domain bus stays silent when a pool has no matching
 * orgs — the CLI's own await always resolves and is the reliable signal.
 * This bridge only forwards the events PoolManager does emit mid-flight.
 */
export function attachPoolDeleteBridge(eventBus: PoolEventBus, uiBus: EventEmitter, tag: string): void {
  eventBus.on('pool:delete:start', p => {
    uiBus.emit('delete:count', {count: p.count, tag});
  });

  eventBus.on('pool:org:deleted', () => {
    uiBus.emit('delete:org:done', {tag});
  });
}
