import type {
  BuildEventBus, OrchestrationEventBus, PendingValidationDescriptor, ValidationEventBus,
} from '@b64hub/sfpm-core';
import type EventEmitter from 'node:events';

/**
 * Bridges core orchestrator events onto the ink App's uiBus using the App's
 * own vocabulary (orchestration:*, package:*, step:*).
 *
 * The App knows nothing about builds or installs — that translation lives here.
 *
 * When `validationBus` is provided (ink interactive path):
 *   - Packages with `validate:queued` enter `'validating'` status instead of
 *     flushing to terminal. They stay in the live area until the validation
 *     bus resolves them to success/failed.
 *   - The version buffer carries the build artifact version through to the
 *     final package:complete so the MetaCols can display it.
 *
 * Without `validationBus` (plain/json path):
 *   - Validation is handled separately by ValidationProgressRenderer (Listr).
 *   - Packages with pending validation still flush to terminal from the
 *     orchestrator's view — they won't appear in the App's live area post-build.
 */
export function attachBuildBridge(
  buildBus: BuildEventBus,
  orchestrationBus: OrchestrationEventBus<PendingValidationDescriptor>,
  uiBus: EventEmitter,
  validationBus?: ValidationEventBus,
): void {
  // Carries the build artifact version string from buildBus 'complete' through
  // to the final package:complete (which may fire from the validation bridge).
  const versionBuffer = new Map<string, string>();

  // Packages that have emitted validate:queued — their terminal status is
  // deferred until the validation bus resolves them.
  const pendingValidation = new Set<string>();

  // ── Orchestration lifecycle ────────────────────────────────────────────────

  orchestrationBus.on('start' as any, (e: any) => {
    uiBus.emit('orchestration:init', {levels: e.levels});
  });

  orchestrationBus.on('complete' as any, (e: any) => {
    const success = (e.results as any[]).every((r: any) => r.success || r.skipped);
    uiBus.emit('orchestration:complete', {success});
  });

  // Single source of truth for final package status — covers success/fail/skip.
  // For packages with pending validation, hold at 'validating' until the bus resolves.
  orchestrationBus.on('package:complete' as any, (e: any) => {
    if (pendingValidation.has(e.packageName)) {
      // Stay non-terminal: keep the package in the live area during validation.
      uiBus.emit('package:complete', {packageName: e.packageName, status: 'validating'});
      uiBus.emit('step:start', {packageName: e.packageName, step: 'validate'});
    } else {
      const status = e.skipped ? 'skipped' : e.success ? 'success' : 'failed';
      const version = versionBuffer.get(e.packageName);
      versionBuffer.delete(e.packageName);
      uiBus.emit('package:complete', {
        detail: e.error,
        errorDetails: e.errorDetails,
        meta: version ? {version} : undefined,
        packageName: e.packageName,
        status,
      });
    }
  });

  // ── Per-package ────────────────────────────────────────────────────────────

  buildBus.on('start' as any, (e: any) => {
    uiBus.emit('package:running', {packageName: e.packageName});
  });

  // Buffer version for the final package:complete; track pending validation.
  buildBus.on('complete' as any, (e: any) => {
    if (e.version) versionBuffer.set(e.packageName, e.version);
  });

  buildBus.on('validate:queued' as any, (e: any) => {
    pendingValidation.add(e.packageName);
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

  // Best-effort task findings (local compile/dependency checks) — never
  // affect status, just accumulate onto the package row as a warning badge.
  buildBus.on('task:complete' as any, (e: any) => {
    if (!e.warnings?.length) return;
    uiBus.emit('package:warn', {packageName: e.packageName, warnings: e.warnings});
  });

  // ── Validation (ink path only) ─────────────────────────────────────────────
  // These handlers resolve packages that are in 'validating' status to their
  // final terminal state. The version buffer carries through from the build.

  if (!validationBus) return;

  validationBus.on('resolve:status' as any, (e: any) => {
    const detail
      = e.status === 'polling'
        ? `polling${e.attempt ? ` (attempt ${e.attempt})` : ''}`
        : e.status === 'queued'
          ? `queued${e.waitingFor ? ` — ${e.waitingFor}` : ''}`
          : 'validating...';
    uiBus.emit('step:update', {detail, packageName: e.packageName, step: 'validate'});
  });

  validationBus.on('resolve:passed' as any, (e: any) => {
    const version = versionBuffer.get(e.packageName);
    versionBuffer.delete(e.packageName);
    pendingValidation.delete(e.packageName);
    uiBus.emit('step:complete', {packageName: e.packageName, status: 'success', step: 'validate'});
    uiBus.emit('package:complete', {meta: version ? {version} : undefined, packageName: e.packageName, status: 'success'});
  });

  validationBus.on('resolve:failed' as any, (e: any) => {
    pendingValidation.delete(e.packageName);
    versionBuffer.delete(e.packageName);
    uiBus.emit('step:complete', {
      detail: e.error, packageName: e.packageName, status: 'failed', step: 'validate',
    });
    uiBus.emit('package:complete', {detail: e.error, packageName: e.packageName, status: 'failed'});
  });

  validationBus.on('resolve:timeout' as any, (e: any) => {
    pendingValidation.delete(e.packageName);
    versionBuffer.delete(e.packageName);
    uiBus.emit('step:complete', {
      detail: 'timed out', packageName: e.packageName, status: 'failed', step: 'validate',
    });
    uiBus.emit('package:complete', {detail: 'timed out', packageName: e.packageName, status: 'failed'});
  });
}
