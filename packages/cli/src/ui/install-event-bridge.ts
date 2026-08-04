import type {
  InstallEventBus, InstallResult, OrchestrationEventBus,
} from '@b64hub/sfpm-core';
import type EventEmitter from 'node:events';

/**
 * Bridges InstallOrchestrator events onto the ink App's uiBus using the App's
 * own vocabulary (orchestration:*, package:*, step:*).
 *
 * Used by both `install` and `deploy` commands — both drive InstallOrchestrator.
 */
export function attachInstallBridge(
  installBus: InstallEventBus,
  orchestrationBus: OrchestrationEventBus<InstallResult>,
  uiBus: EventEmitter,
): void {
  // Buffer version and component count from mid-lifecycle events for the
  // final package:complete meta, which fires from the orchestration bus.
  const versionBuffer = new Map<string, string>();
  const componentsBuffer = new Map<string, number>();

  // ── Orchestration lifecycle ────────────────────────────────────────────────

  orchestrationBus.on('start' as any, (e: any) => {
    uiBus.emit('orchestration:init', {levels: e.levels});
  });

  orchestrationBus.on('complete' as any, (e: any) => {
    const success = (e.results as any[]).every((r: any) => r.success || r.skipped);
    uiBus.emit('orchestration:complete', {success});
  });

  // Single source of truth for terminal package status.
  orchestrationBus.on('package:complete' as any, (e: any) => {
    const status = e.skipped ? 'skipped' : e.success ? 'success' : 'failed';
    const version = versionBuffer.get(e.packageName);
    const components = componentsBuffer.get(e.packageName);
    versionBuffer.delete(e.packageName);
    componentsBuffer.delete(e.packageName);
    const meta = version || components
      ? {...(version ? {version} : {}), ...(components ? {components: String(components)} : {})}
      : undefined;
    uiBus.emit('package:complete', {
      detail: e.error, errorDetails: e.errorDetails, meta, packageName: e.packageName, status,
    });
  });

  // ── Per-package ────────────────────────────────────────────────────────────

  installBus.on('start' as any, (e: any) => {
    uiBus.emit('package:running', {packageName: e.packageName});
  });

  // Buffer version number so it reaches package:complete meta.
  installBus.on('complete' as any, (e: any) => {
    if (e.versionNumber) versionBuffer.set(e.packageName, e.versionNumber);
  });

  // ── Connection ─────────────────────────────────────────────────────────────

  installBus.on('connection:start' as any, (e: any) => {
    uiBus.emit('step:start', {detail: e.username, packageName: e.packageName, step: 'connect'});
  });

  installBus.on('connection:complete' as any, (e: any) => {
    uiBus.emit('step:complete', {
      detail: e.username, packageName: e.packageName, status: 'success', step: 'connect',
    });
  });

  // ── Deployment (source packages) ───────────────────────────────────────────

  installBus.on('deploy:start' as any, (e: any) => {
    uiBus.emit('step:start', {detail: e.targetOrg, packageName: e.packageName, step: 'deploy'});
  });

  installBus.on('deploy:progress' as any, (e: any) => {
    const deployed = e.numberComponentsDeployed ?? 0;
    const total = e.numberComponentsTotal ?? 0;
    const detail = total > 0
      ? `${deployed}/${total} (${Math.round((deployed / total) * 100)}%)`
      : e.status ?? 'deploying';
    uiBus.emit('step:update', {detail, packageName: e.packageName, step: 'deploy'});
  });

  installBus.on('deploy:complete' as any, (e: any) => {
    if (e.numberComponentsDeployed) componentsBuffer.set(e.packageName, e.numberComponentsDeployed);
    uiBus.emit('step:complete', {packageName: e.packageName, status: 'success', step: 'deploy'});
  });

  // ── Version install (unlocked packages) ────────────────────────────────────

  installBus.on('version:start' as any, (e: any) => {
    uiBus.emit('step:start', {packageName: e.packageName, step: 'install'});
  });

  installBus.on('version:progress' as any, (e: any) => {
    uiBus.emit('step:update', {detail: e.status ?? 'installing', packageName: e.packageName, step: 'install'});
  });

  installBus.on('version:complete' as any, (e: any) => {
    uiBus.emit('step:complete', {packageName: e.packageName, status: 'success', step: 'install'});
  });

  // ── Hooks ──────────────────────────────────────────────────────────────────

  installBus.on('hooks:start' as any, (e: any) => {
    if (e.hookCount === 0) return;
    uiBus.emit('step:start', {packageName: e.packageName, step: `${e.timing}-hooks`});
  });

  installBus.on('hooks:complete' as any, (e: any) => {
    if (e.completedCount === 0) return;
    uiBus.emit('step:complete', {packageName: e.packageName, status: 'success', step: `${e.timing}-hooks`});
  });
}
