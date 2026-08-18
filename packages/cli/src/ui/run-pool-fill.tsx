import type {PoolEventBus} from '@b64hub/sfpm-orgs';
import type {Instance} from 'ink';
import type EventEmitter from 'node:events';

import {render} from 'ink';

import {PoolFillApp} from './apps/PoolFillApp.js';
import {attachPoolFillBridge} from './pool-fill-event-bridge.js';

/**
 * Mount the pool fill Ink UI.
 *
 * `uiBus` must be the same bus passed to `createRunLogger(uiBus)` so that
 * pino log records get bridged into the ink app instead of writing raw to
 * stderr (which races with Ink's redraws and garbles the terminal).
 * Wires the pool manager bridge onto it and renders the PoolFillApp.
 * The app self-exits when pool:provision:complete is received, so call
 * `await instance.waitUntilExit()` after `manager.provision()`.
 */
export function renderPoolFill(uiBus: EventEmitter, eventBus: PoolEventBus, devhubAlias: string): Instance {
  attachPoolFillBridge(eventBus, uiBus);
  return render(<PoolFillApp bus={uiBus} devhubAlias={devhubAlias} />);
}
