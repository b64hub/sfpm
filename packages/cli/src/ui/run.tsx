import type EventEmitter from 'node:events';
import type {Instance} from 'ink';

import {render} from 'ink';

import {App} from './components/App.js';

export function renderApp(bus: EventEmitter): Instance {
  return render(<App bus={bus} />);
}
