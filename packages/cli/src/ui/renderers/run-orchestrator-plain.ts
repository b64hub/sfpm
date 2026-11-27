import type {ErrorDetail} from '@b64hub/sfpm-core';
import type EventEmitter from 'node:events';

import {formatDuration, type RenderHandle} from '../utils/renderer-utils.js';

/** Max component-level reasons printed under a failed package before summarizing. */
const ERROR_LINES_MAX = 5;

export interface RenderOrchestratorPlainOptions {
  /** Path to the full run log, printed when there is more detail than shown inline. */
  logPath?: string;
}

/** One bullet per component-level reason, capped at {@link ERROR_LINES_MAX}. */
function printErrorDetails(errorDetails: ErrorDetail[], logPath: string | undefined): void {
  for (const {label, message} of errorDetails.slice(0, ERROR_LINES_MAX)) {
    // Salesforce problem strings can be multi-line; keep one bullet per line.
    console.log(`  - ${label}: ${message.replaceAll(/\s+/g, ' ').trim()}`);
  }

  const remaining = errorDetails.length - ERROR_LINES_MAX;
  if (remaining > 0) console.log(`  +${remaining} more — see full logs${logPath ? `: ${logPath}` : ''}`);
}

/**
 * Plain-mode renderer: one flat text line per package transition. No ink,
 * no color, no icons, no spinners — just what happened and how long it took.
 *
 * Subscribes directly to the same bus the ink bridge
 * (attachBuildBridge/attachInstallBridge) already feeds — no separate
 * wiring needed, and no dependency on the interactive tree/reducer.
 */
export function renderOrchestratorPlain(bus: EventEmitter, options: RenderOrchestratorPlainOptions = {}): RenderHandle {
  const startedAt = new Map<string, number>();

  const onOrchestrationComplete = ({success}: {success: boolean}) => {
    console.log(success ? 'succeeded' : 'failed');
    if (!success && options.logPath) console.log(`Full logs: ${options.logPath}`);
  };

  const onRunning = ({packageName}: {packageName: string}) => {
    startedAt.set(packageName, Date.now());
    console.log(`${packageName}: started`);
  };

  const onComplete = ({detail, errorDetails, packageName, status}: {detail?: string; errorDetails?: ErrorDetail[]; packageName: string; status: string}) => {
    if (status === 'validating') return; // not terminal yet — wait for the real outcome

    const started = startedAt.get(packageName);
    startedAt.delete(packageName);
    const elapsed = started ? ` (${formatDuration(Date.now() - started)})` : '';

    if (status === 'failed') {
      console.log(`${packageName}: failed${detail ? ` — ${detail}` : ''}`);
      if (errorDetails?.length) printErrorDetails(errorDetails, options.logPath);
    } else if (status === 'skipped') console.log(`${packageName}: skipped`);
    else console.log(`${packageName}: done${elapsed}`);
  };

  bus.on('package:running', onRunning);
  bus.on('package:complete', onComplete);
  bus.on('orchestration:complete', onOrchestrationComplete);

  return {
    unmount() {
      bus.off('package:running', onRunning);
      bus.off('package:complete', onComplete);
      bus.off('orchestration:complete', onOrchestrationComplete);
    },
    async waitUntilExit() {
      // Every line is already flushed synchronously as its event arrives —
      // nothing pending to wait for (unlike ink's async render flush).
    },
  };
}
