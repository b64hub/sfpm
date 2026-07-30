import type {PoolManager} from '@b64hub/sfpm-orgs';
import type EventEmitter from 'node:events';

/**
 * Bridges PoolManager events onto the PoolFillApp's uiBus.
 *
 * The bridge owns the translation from pool domain events to the
 * flat uiBus vocabulary consumed by PoolFillApp's reducer.
 */
export function attachPoolFillBridge(manager: PoolManager, uiBus: EventEmitter): void {
  manager.on('pool:provision:start', p => {
    uiBus.emit('pool:start', {tag: p.tag, total: p.toAllocate});
  });

  manager.on('pool:org:created', p => {
    uiBus.emit('org:appeared', {alias: p.alias, username: p.username});
  });

  // Creation failure — no username, just bump the counter
  manager.on('pool:org:failed', () => {
    uiBus.emit('pool:creation:failed');
  });

  manager.on('pool:task:start', p => {
    if (p.task === 'install-sfpm-package') {
      uiBus.emit('org:prereqs', {username: p.username});
    } else if (p.task === 'deploy-packages') {
      uiBus.emit('org:deploying', {username: p.username});
    }
  });

  manager.on('pool:package:start', p => {
    uiBus.emit('org:pkg:start', {packageName: p.packageName, total: p.total, username: p.username});
  });

  manager.on('pool:package:complete', p => {
    uiBus.emit('org:pkg:done', {
      packageName: p.packageName, success: p.success, username: p.username, version: p.version,
    });
  });

  // deploy-packages completing signals the org is fully provisioned
  manager.on('pool:task:complete', p => {
    if (p.task === 'deploy-packages') {
      uiBus.emit('org:done', {username: p.username});
    }
  });

  // Task error or post-creation discard → org failed
  manager.on('pool:task:error', p => {
    uiBus.emit('org:failed', {username: p.username});
  });

  manager.on('pool:org:discarded', p => {
    uiBus.emit('org:failed', {username: p.username});
  });

  manager.on('pool:provision:complete', () => {
    uiBus.emit('pool:done');
  });
}
