import type {Instance} from 'ink';
import type EventEmitter from 'node:events';

import {render} from 'ink';

import {PoolFillApp} from './apps/PoolFillApp.js';

/**
 * Mount the pool fill Ink UI.
 *
 * `uiBus` must be the same bus passed to `createRunLogger(uiBus)` so that
 * pino log records get bridged into the ink app instead of writing raw to
 * stderr (which races with Ink's redraws and garbles the terminal).
 *
 * One `PoolFillApp` instance is shared across every tag being filled —
 * call `attachPoolFillBridge` once per manager (one per tag) against the
 * bus returned here, then render once. The app self-exits once every pool
 * it has seen a `pool:start` for has also reported `pool:done`.
 */
export function renderPoolFill(uiBus: EventEmitter, devhubAlias: string): Instance {
  return render(<PoolFillApp bus={uiBus} devhubAlias={devhubAlias} />);
}
