import type EventEmitter from 'node:events';

import {render} from 'ink';

import type {ConnectedOrg} from '../apps/BuildApp.js';
import type {RenderHandle} from '../utils/renderer-utils.js';

import {App} from '../apps/BuildApp.js';
import {renderOrchestratorPlain} from './run-orchestrator-plain.js';

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
  /** Called with each keypress when step-mode is active. Interactive only. */
  onAdvance?: (key: string) => void;
  /** Connected org badge shown above the package tree, when known. */
  org?: ConnectedOrg;
}

/**
 * Single entrypoint for both interactive and plain rendering — callers never
 * branch on mode themselves, they just get a handle back. Plain mode is a
 * flat text subscriber (see run-orchestrator-plain.ts), not an Ink render, so it carries
 * none of the interactive tree's color/icon/spinner components.
 */
export function renderApp(bus: EventEmitter, options: RenderAppOptions = {}): RenderHandle {
  const mode = options.mode ?? (process.stdout.isTTY ? 'interactive' : 'plain');
  if (mode === 'plain') return renderOrchestratorPlain(bus);
  return render(
    <App bus={bus} logPath={options.logPath} onAdvance={options.onAdvance} org={options.org} />,
    {interactive: true},
  );
}
