import type EventEmitter from 'node:events';

import {formatDuration, type RenderHandle} from '../utils/renderer-utils.js';

function onOrchestrationComplete({success}: {success: boolean}) {
  console.log(success ? 'succeeded' : 'failed');
}

/**
 * Plain-mode renderer: one flat text line per package transition. No ink,
 * no color, no icons, no spinners — just what happened and how long it took.
 *
 * Subscribes directly to the same bus the ink bridge
 * (attachBuildBridge/attachInstallBridge) already feeds — no separate
 * wiring needed, and no dependency on the interactive tree/reducer.
 */
export function renderOrchestratorPlain(bus: EventEmitter): RenderHandle {
  const startedAt = new Map<string, number>();

  const onRunning = ({packageName}: {packageName: string}) => {
    startedAt.set(packageName, Date.now());
    console.log(`${packageName}: started`);
  };

  const onComplete = ({detail, packageName, status}: {detail?: string; packageName: string; status: string}) => {
    if (status === 'validating') return; // not terminal yet — wait for the real outcome

    const started = startedAt.get(packageName);
    startedAt.delete(packageName);
    const elapsed = started ? ` (${formatDuration(Date.now() - started)})` : '';

    if (status === 'failed') console.log(`${packageName}: failed${detail ? ` — ${detail}` : ''}`);
    else if (status === 'skipped') console.log(`${packageName}: skipped`);
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
