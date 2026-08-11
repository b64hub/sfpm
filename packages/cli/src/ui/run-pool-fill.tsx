import type {PoolEventBus} from '@b64hub/sfpm-orgs';
import type {Instance} from 'ink';

import EventEmitter from 'node:events';
import {render} from 'ink';

import {attachPoolFillBridge} from './pool-fill-event-bridge.js';
import {PoolFillApp} from './apps/PoolFillApp.js';

/**
 * Mount the pool fill Ink UI.
 *
 * Creates an internal event bus, wires the pool manager bridge onto it,
 * and renders the PoolFillApp. The app self-exits when pool:provision:complete
 * is received, so call `await instance.waitUntilExit()` after `manager.provision()`.
 */
export function renderPoolFill(eventBus: PoolEventBus, devhubAlias: string): Instance {
  const uiBus = new EventEmitter();
  attachPoolFillBridge(eventBus, uiBus);
  return render(<PoolFillApp bus={uiBus} devhubAlias={devhubAlias} />);
}
