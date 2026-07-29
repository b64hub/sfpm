import type EventEmitter from 'node:events';
import type {Instance} from 'ink';

import {render} from 'ink';

import {App} from './components/App.js';

export interface RenderAppOptions {
  /** Called with each keypress when step-mode is active. */
  onAdvance?: (key: string) => void;
}

export function renderApp(bus: EventEmitter, opts: RenderAppOptions = {}): Instance {
  return render(<App bus={bus} onAdvance={opts.onAdvance} />);
}
