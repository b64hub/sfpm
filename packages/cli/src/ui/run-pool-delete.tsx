import type {Instance} from 'ink';
import type EventEmitter from 'node:events';

import {render} from 'ink';

import {PoolDeleteApp} from './apps/PoolDeleteApp.js';

/**
 * Mount the pool delete Ink UI.
 *
 * One `PoolDeleteApp` instance is shared across every tag being deleted —
 * call `attachPoolDeleteBridge` once per manager (one per tag) against the
 * bus returned here, then render once. The app self-exits once every row
 * it has seen a `delete:start` for has also reported `delete:done`.
 */
export function renderPoolDelete(uiBus: EventEmitter, devhubAlias: string): Instance {
  return render(<PoolDeleteApp bus={uiBus} devhubAlias={devhubAlias} />);
}
