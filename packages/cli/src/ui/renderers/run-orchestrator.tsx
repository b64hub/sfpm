import type EventEmitter from 'node:events';
import type {Instance} from 'ink';

import {render} from 'ink';

import type {ConnectedOrg} from '../apps/BuildApp.js';

import {App} from '../apps/BuildApp.js';

export interface RenderAppOptions {
  /** Path to the run log file, shown on failure in the final frame. */
  logPath?: string;
  /**
   * Force plain vs interactive rendering. Omit to let Ink auto-detect from
   * CI/TTY (it already handles this natively — no need to duplicate it
   * here). Only pass this when the CLI resolved an output mode Ink couldn't
   * have known about on its own (e.g. an explicit --plain/--json flag).
   */
  mode?: 'interactive' | 'plain';
  /** Called with each keypress when step-mode is active. */
  onAdvance?: (key: string) => void;
  /** Connected org badge shown above the package tree, when known. */
  org?: ConnectedOrg;
}

export function renderApp(bus: EventEmitter, options: RenderAppOptions = {}): Instance {
  // No explicit mode: mirror Ink's own default (isTTY) for the component's
  // own flush-strategy prop, but still let Ink resolve `interactive` itself
  // (it also checks CI, which this doesn't need to duplicate).
  const mode = options.mode ?? (process.stdout.isTTY ? 'interactive' : 'plain');
  return render(
    <App bus={bus} logPath={options.logPath} mode={mode} onAdvance={options.onAdvance} org={options.org} />,
    options.mode ? {interactive: options.mode === 'interactive'} : undefined,
  );
}
