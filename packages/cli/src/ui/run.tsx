import type EventEmitter from 'node:events';
import type {Instance} from 'ink';

import {render} from 'ink';

import type {ConnectedOrg} from './apps/BuildApp.js';

import {App} from './apps/BuildApp.js';

export interface RenderAppOptions {
  /** Path to the run log file, shown on failure in the final frame. */
  logPath?: string;
  /** Called with each keypress when step-mode is active. */
  onAdvance?: (key: string) => void;
  /** Connected org badge shown above the package tree, when known. */
  org?: ConnectedOrg;
}

export function renderApp(bus: EventEmitter, opts: RenderAppOptions = {}): Instance {
  return render(<App bus={bus} logPath={opts.logPath} onAdvance={opts.onAdvance} org={opts.org} />);
}
