import type {PoolEventBus} from '@b64hub/sfpm-orgs';
import type EventEmitter from 'node:events';

/**
 * Bridges PoolManager events onto the PoolFillApp's uiBus.
 *
 * The bridge owns the translation from pool domain events to the
 * flat uiBus vocabulary consumed by PoolFillApp's reducer.
 */
export function attachPoolFillBridge(eventBus: PoolEventBus, uiBus: EventEmitter): void {
  eventBus.on('pool:provision:start', p => {
    uiBus.emit('pool:start', {tag: p.tag, total: p.toAllocate});
  });

  eventBus.on('pool:org:created', p => {
    uiBus.emit('org:appeared', {alias: p.alias, username: p.username});
  });

  // Creation failure — org never provisioned, forward alias for display
  eventBus.on('pool:org:failed', p => {
    uiBus.emit('pool:creation:failed', {alias: p.alias});
  });

  eventBus.on('pool:task:start', p => {
    if (p.task === 'install-sfpm-package') {
      uiBus.emit('org:prereqs', {username: p.username});
    } else if (p.task === 'deploy-packages') {
      uiBus.emit('org:deploying', {username: p.username});
    }
  });

  eventBus.on('pool:package:start', p => {
    uiBus.emit('org:pkg:start', {packageName: p.packageName, total: p.total, username: p.username});
  });

  eventBus.on('pool:package:complete', p => {
    uiBus.emit('org:pkg:done', {
      packageName: p.packageName, success: p.success, username: p.username, version: p.version,
    });
  });

  // deploy-packages completing signals the org is fully provisioned
  eventBus.on('pool:task:complete', p => {
    if (p.task === 'deploy-packages') {
      uiBus.emit('org:done', {username: p.username});
    }
  });

  // Task error or post-creation discard → org failed
  eventBus.on('pool:task:error', p => {
    uiBus.emit('org:failed', {username: p.username});
  });

  eventBus.on('pool:org:discarded', p => {
    uiBus.emit('org:failed', {username: p.username});
  });

  eventBus.on('pool:provision:complete', () => {
    uiBus.emit('pool:done');
  });
}
