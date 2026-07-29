import type {BuildEventBus, OrchestrationEventBus, PendingValidationDescriptor} from '@b64hub/sfpm-core';
import type EventEmitter from 'node:events';

/**
 * Bridges core orchestrator events onto the ink App's uiBus using the App's
 * own vocabulary (orchestration:*, package:*, step:*, log:append).
 *
 * The App knows nothing about builds or installs — that translation lives here.
 *
 * Final package status comes exclusively from orchestrationBus 'package:complete'
 * (covers success, failure, and skip in one place). A version buffer carries the
 * version string from buildBus 'complete' so it can be included as meta.
 *
 * ponytail: meta only carries `version` for now. `hash` and `components` require
 *   additional payload fields from the core — add when available.
 */
export function attachBuildBridge(
  buildBus: BuildEventBus,
  orchestrationBus: OrchestrationEventBus<PendingValidationDescriptor>,
  uiBus: EventEmitter,
): void {
  // Buffer version strings from buildBus so they're available when
  // orchestrationBus fires its package:complete event.
  const versionBuffer = new Map<string, string>();

  // ── Orchestration lifecycle ────────────────────────────────────────────────

  orchestrationBus.on('start' as any, (e: any) => {
    uiBus.emit('orchestration:init', {levels: e.levels});
  });

  orchestrationBus.on('complete' as any, (e: any) => {
    const success = (e.results as any[]).every((r: any) => r.success || r.skipped);
    uiBus.emit('orchestration:complete', {success});
  });

  // Single source of truth for final package status.
  orchestrationBus.on('package:complete' as any, (e: any) => {
    const status = e.skipped ? 'skipped' : e.success ? 'success' : 'failed';
    const version = versionBuffer.get(e.packageName);
    versionBuffer.delete(e.packageName);

    uiBus.emit('package:complete', {
      detail: e.error,
      meta: version ? {version} : undefined,
      packageName: e.packageName,
      status,
    });
  });

  // ── Per-package running ────────────────────────────────────────────────────

  buildBus.on('start' as any, (e: any) => {
    uiBus.emit('package:running', {packageName: e.packageName});
  });

  // Buffer version for later use by orchestrationBus 'package:complete'.
  buildBus.on('complete' as any, (e: any) => {
    if (e.version) versionBuffer.set(e.packageName, e.version);
  });

  // ── Per-step ───────────────────────────────────────────────────────────────

  buildBus.on('stage:start' as any, (e: any) => {
    uiBus.emit('step:start', {packageName: e.packageName, step: 'stage'});
  });

  buildBus.on('stage:complete' as any, (e: any) => {
    uiBus.emit('step:complete', {packageName: e.packageName, status: 'success', step: 'stage'});
  });

  buildBus.on('analyzers:start' as any, (e: any) => {
    uiBus.emit('step:start', {packageName: e.packageName, step: 'analyze'});
  });

  buildBus.on('analyzers:complete' as any, (e: any) => {
    uiBus.emit('step:complete', {packageName: e.packageName, status: 'success', step: 'analyze'});
  });

  buildBus.on('builder:start' as any, (e: any) => {
    uiBus.emit('step:start', {detail: e.builderName, packageName: e.packageName, step: 'build'});
  });

  buildBus.on('builder:complete' as any, (e: any) => {
    uiBus.emit('step:complete', {packageName: e.packageName, status: 'success', step: 'build'});
  });

  buildBus.on('hooks:start' as any, (e: any) => {
    if (e.hookCount === 0) return;
    uiBus.emit('step:start', {packageName: e.packageName, step: `${e.timing}-hooks`});
  });

  buildBus.on('hooks:complete' as any, (e: any) => {
    if (e.completedCount === 0) return;
    uiBus.emit('step:complete', {packageName: e.packageName, status: 'success', step: `${e.timing}-hooks`});
  });
}
