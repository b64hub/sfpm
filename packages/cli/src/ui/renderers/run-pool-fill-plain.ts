import type EventEmitter from 'node:events';

import type {RenderHandle} from '../utils/renderer-utils.js';

interface OrgRef {
  alias: string;
  tag: string;
}

/**
 * Plain-mode renderer for `pool fill`: one flat text line per org/pool
 * transition, no ink/color/icons. Subscribes directly to the same bus
 * `attachPoolFillBridge` already feeds. Per-package progress
 * (org:pkg:start/done) is skipped — org-level only, same granularity as
 * the build/install plain renderer.
 */
export function renderPoolFillPlain(bus: EventEmitter): RenderHandle {
  const orgs = new Map<string, OrgRef>(); // username -> {alias, tag}
  const done = new Map<string, number>(); // tag -> succeeded count
  const failed = new Map<string, number>(); // tag -> failed count (creation + provisioning)

  const onPoolStart = ({tag, total}: {tag: string; total: number}) => {
    done.set(tag, 0);
    failed.set(tag, 0);
    console.log(`${tag}: provisioning ${total} org${total === 1 ? '' : 's'}`);
  };

  const onOrgAppeared = ({alias, tag, username}: {alias: string; tag: string; username: string}) => {
    orgs.set(username, {alias, tag});
    console.log(`${tag}: ${alias} created`);
  };

  const onOrgDone = ({username}: {username: string}) => {
    const org = orgs.get(username);
    if (!org) return;
    done.set(org.tag, (done.get(org.tag) ?? 0) + 1);
    console.log(`${org.tag}: ${org.alias} ready`);
  };

  const onOrgFailed = ({username}: {username: string}) => {
    const org = orgs.get(username);
    failed.set(org?.tag ?? 'unknown', (failed.get(org?.tag ?? 'unknown') ?? 0) + 1);
    console.log(`${org ? `${org.tag}: ${org.alias}` : username} failed`);
  };

  const onCreationFailed = ({tag}: {tag: string}) => {
    failed.set(tag, (failed.get(tag) ?? 0) + 1);
    console.log(`${tag}: org creation failed`);
  };

  const onPoolDone = ({tag}: {tag: string}) => {
    console.log(`${tag}: done — ${done.get(tag) ?? 0} succeeded, ${failed.get(tag) ?? 0} failed`);
  };

  bus.on('pool:start', onPoolStart);
  bus.on('org:appeared', onOrgAppeared);
  bus.on('org:done', onOrgDone);
  bus.on('org:failed', onOrgFailed);
  bus.on('pool:creation:failed', onCreationFailed);
  bus.on('pool:done', onPoolDone);

  return {
    unmount() {
      bus.off('pool:start', onPoolStart);
      bus.off('org:appeared', onOrgAppeared);
      bus.off('org:done', onOrgDone);
      bus.off('org:failed', onOrgFailed);
      bus.off('pool:creation:failed', onCreationFailed);
      bus.off('pool:done', onPoolDone);
    },
    async waitUntilExit() {
      // Every line is already flushed synchronously as its event arrives.
    },
  };
}
