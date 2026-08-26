import type EventEmitter from 'node:events';

import {render} from 'ink';

import type {RenderHandle} from '../utils/renderer-utils.js';

import {PoolDeleteApp} from '../apps/PoolDeleteApp.js';
import {renderPoolDeletePlain} from './run-pool-delete-plain.js';

/**
 * Mount the pool delete UI — single entrypoint for both interactive and
 * plain rendering (see run-orchestrator.tsx for the same fork pattern).
 *
 * One instance is shared across every tag being deleted — call
 * `attachPoolDeleteBridge` once per manager (one per tag) against the bus
 * passed here, then render once. The interactive app self-exits once every
 * row it has seen a `delete:start` for has also reported `delete:done`.
 */
export function renderPoolDelete(uiBus: EventEmitter, devhubAlias: string, mode?: 'interactive' | 'plain'): RenderHandle {
  const resolved = mode ?? (process.stdout.isTTY ? 'interactive' : 'plain');
  if (resolved === 'plain') return renderPoolDeletePlain(uiBus);
  return render(<PoolDeleteApp bus={uiBus} devhubAlias={devhubAlias} />, {interactive: true});
}
