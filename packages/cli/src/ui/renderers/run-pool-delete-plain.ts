import type EventEmitter from 'node:events';

import type {RenderHandle} from '../utils/renderer-utils.js';

function onCount({count, tag}: {count: number; tag: string}) {
  console.log(`${tag}: deleting ${count} org${count === 1 ? '' : 's'}`);
}

function onDone({deleted, errors, tag}: {deleted: number; errors: string[]; tag: string}) {
  console.log(errors.length > 0
    ? `${tag}: ${deleted} deleted, ${errors.length} error${errors.length === 1 ? '' : 's'}`
    : `${tag}: ${deleted} deleted`);
}

/**
 * Plain-mode renderer for `pool delete`: one flat text line per tag, no
 * ink/color/icons. Subscribes directly to the same bus
 * `attachPoolDeleteBridge`/the command itself already feeds.
 *
 * `delete:count` may never fire (the domain bus stays silent for a pool
 * with no matching orgs — see attachPoolDeleteBridge) but `delete:done`
 * always does, so the final summary line is guaranteed regardless.
 */
export function renderPoolDeletePlain(bus: EventEmitter): RenderHandle {
  bus.on('delete:count', onCount);
  bus.on('delete:done', onDone);

  return {
    unmount() {
      bus.off('delete:count', onCount);
      bus.off('delete:done', onDone);
    },
    async waitUntilExit() {
      // Every line is already flushed synchronously as its event arrives.
    },
  };
}
