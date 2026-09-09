import type EventEmitter from 'node:events';

import {render} from 'ink';

import type {RenderHandle} from '../utils/renderer-utils.js';

import {PoolFillApp} from '../apps/PoolFillApp.js';
import {renderPoolFillPlain} from './run-pool-fill-plain.js';

/**
 * Mount the pool fill UI — single entrypoint for both interactive and
 * plain rendering (see run-orchestrator.tsx for the same fork pattern).
 *
 * `uiBus` must be the same bus passed to `createRunLogger(uiBus)` so that
 * pino log records get bridged into the ink app instead of writing raw to
 * stderr (which races with Ink's redraws and garbles the terminal).
 *
 * One instance is shared across every tag being filled — call
 * `attachPoolFillBridge` once per manager (one per tag) against the bus
 * passed here, then render once. The interactive app self-exits once every
 * pool it has seen a `pool:start` for has also reported `pool:done`.
 */
export function renderPoolFill(uiBus: EventEmitter, devhubAlias: string, mode?: 'interactive' | 'plain'): RenderHandle {
  const resolved = mode ?? (process.stdout.isTTY ? 'interactive' : 'plain');
  if (resolved === 'plain') return renderPoolFillPlain(uiBus);
  return render(<PoolFillApp bus={uiBus} devhubAlias={devhubAlias} />, {interactive: true});
}
