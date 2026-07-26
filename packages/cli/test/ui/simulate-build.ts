#!/usr/bin/env npx tsx
/**
 * Visual simulation of the flat per-package build rendering followed by
 * inline validation — mirroring the real sfpm build → resolveValidationsInline
 * execution path as closely as possible.
 *
 * Run with: npx tsx packages/cli/test/ui/simulate-build.ts
 *
 * Demonstrates:
 * - Flat package-level Listr tasks (no level wrappers)
 * - Sub-tasks for build phases and validation queued
 * - Sub-tasks collapse on success, stay expanded on failure
 * - Post-build validation section: ValidationProgressRenderer created AFTER
 *   buildAll() returns (matching resolveValidationsInline), not upfront
 * - Deploy-style validation (direct pass/fail) for source packages
 * - Polling-style validation for unlocked packages
 * - Summary line instead of result box
 */
import type {ValidationEvents} from '@b64hub/sfpm-core';

import {BuildEventBus, OrchestrationEventBus, ValidationEventBus} from '@b64hub/sfpm-core';
import {writeSync} from 'node:fs';
import {DefaultRenderer, ProcessOutput} from 'listr2';

import {BuildProgressRenderer} from '../../src/ui/build-progress-renderer.js';
import {ValidationProgressRenderer} from '../../src/ui/validation-progress-renderer.js';
import {renderBuildSummary} from '../../src/ui/build-summary.js';
import {EventSimulator, type TimelineEntry} from './event-simulator.js';

const logger = {
  error: (msg: Error | string) => console.error(msg),
  log: (msg: string) => console.log(msg),
};

// ============================================================================
// DIAGNOSTIC INSTRUMENTATION
// ----------------------------------------------------------------------------
// Trace the Listr renderer lifecycle via a RAW fd-2 write (bypasses any
// stdout/stderr hijack) so we can see the exact interleaving of the build
// renderer's teardown vs the validation renderer's startup — where the bug lives.
//
// Run in a REAL terminal (your TTY) to reproduce the DefaultRenderer path.
// Set LISTR_FORCE_TTY=1 to force DefaultRenderer in a pipe (sandbox testing),
// but a spinner writing to a pipe can starve the loop (sandbox-only artifact).
// ============================================================================

const t0 = Date.now();
let rendererSeq = 0;
const tr = (msg: string) => writeSync(2, `\n‹trace +${String(Date.now() - t0).padStart(5)}ms› ${msg}\n`);

const origRender = DefaultRenderer.prototype.render;
const origEnd = DefaultRenderer.prototype.end;
DefaultRenderer.prototype.render = function (this: any, ...args: any[]) {
  this.__seq ??= ++rendererSeq;
  const first = this?.tasks?.[0]?.title ?? '?';
  tr(`renderer#${this.__seq}.render() START (first task: ${JSON.stringify(first)})`);
  const r = origRender.apply(this, args);
  Promise.resolve(r).then(() => tr(`renderer#${this.__seq}.render() setup DONE (spinner interval live)`));
  return r as any;
};
DefaultRenderer.prototype.end = function (this: any, ...args: any[]) {
  tr(`renderer#${this.__seq ?? '?'}.end() CALLED (stops spinner + releases)`);
  return origEnd.apply(this, args);
};

const origHijack = ProcessOutput.prototype.hijack;
const origRelease = ProcessOutput.prototype.release;
ProcessOutput.prototype.hijack = function (this: any, ...args: any[]) {
  tr(`ProcessOutput.hijack()  (active before = ${this.active})`);
  return origHijack.apply(this, args);
};
ProcessOutput.prototype.release = function (this: any, ...args: any[]) {
  tr(`ProcessOutput.release()`);
  return origRelease.apply(this, args);
};

// ============================================================================
// Setup: buses + renderers
// ============================================================================

const buildBus = new BuildEventBus();
const orchestrationBus = new OrchestrationEventBus('sim-001');

// NOTE: validation bus + renderer are intentionally NOT set up here.
// In sfpm build, resolveValidationsInline() creates them AFTER buildAll()
// returns. Mirroring that is essential to expose the Listr sequencing issue.

// ============================================================================
// Build + Orchestration timeline (interleaved, mirrors real event ordering)
// ============================================================================

type BusEvent = {bus: 'build' | 'orchestration'; delay: number; event: string; payload: any};

const timeline: BusEvent[] = [
  // Orchestrator starts first
  {bus: 'orchestration', delay: 0, event: 'start', payload: {
    includeDependencies: true,
    orchestrationId: 'sim-001',
    packageNames: ['core-data', 'ui-components', 'apex-utils'],
    totalLevels: 2,
    totalPackages: 3,
  }},
  {bus: 'orchestration', delay: 100, event: 'level:start', payload: {
    level: 0,
    orchestrationId: 'sim-001',
    packageDetails: [{isManaged: false, name: 'core-data'}, {isManaged: false, name: 'ui-components'}],
    packages: ['core-data', 'ui-components'],
  }},

  // Level 0: core-data + ui-components build concurrently
  // (interleaved to simulate concurrent execution)
  {bus: 'build', delay: 100, event: 'start', payload: {packageName: 'core-data', packageType: 'Source'}},
  {bus: 'build', delay: 50, event: 'start', payload: {packageName: 'ui-components', packageType: 'Source'}},

  // core-data: pre-build hooks
  {bus: 'build', delay: 200, event: 'hooks:start', payload: {
    hookCount: 2, hookNames: ['lint-check', 'prettier-format'], operation: 'build', packageName: 'core-data', timing: 'pre',
  }},
  {bus: 'build', delay: 600, event: 'hook:complete', payload: {
    hookName: 'lint-check', operation: 'build', packageName: 'core-data', timing: 'pre',
  }},
  {bus: 'build', delay: 400, event: 'hook:complete', payload: {
    hookName: 'prettier-format', operation: 'build', packageName: 'core-data', timing: 'pre',
  }},
  {bus: 'build', delay: 50, event: 'hooks:complete', payload: {
    completedCount: 2, operation: 'build', packageName: 'core-data', timing: 'pre',
  }},

  {bus: 'build', delay: 150, event: 'stage:start', payload: {packageName: 'core-data'}},
  {bus: 'build', delay: 100, event: 'stage:start', payload: {packageName: 'ui-components'}},
  {bus: 'build', delay: 400, event: 'stage:complete', payload: {componentCount: 42, packageName: 'core-data'}},
  {bus: 'build', delay: 100, event: 'builder:start', payload: {packageName: 'core-data', packageType: 'Source'}},
  {bus: 'build', delay: 100, event: 'stage:complete', payload: {componentCount: 18, packageName: 'ui-components'}},
  {bus: 'build', delay: 100, event: 'builder:start', payload: {packageName: 'ui-components', packageType: 'Source'}},
  {bus: 'build', delay: 100, event: 'task:start', payload: {packageName: 'core-data', taskName: 'MetadataDeployTask', taskType: 'pre-build'}},
  {bus: 'build', delay: 100, event: 'task:start', payload: {packageName: 'ui-components', taskName: 'MetadataDeployTask', taskType: 'pre-build'}},
  {bus: 'build', delay: 1200, event: 'task:complete', payload: {packageName: 'core-data', success: true, taskName: 'MetadataDeployTask'}},
  {bus: 'build', delay: 100, event: 'builder:complete', payload: {componentCount: 42, packageName: 'core-data'}},
  {bus: 'build', delay: 50, event: 'validate:queued', payload: {operationId: 'deploy-001', operationType: 'deploy', packageName: 'core-data'}},
  {bus: 'build', delay: 100, event: 'assemble:start', payload: {packageName: 'core-data'}},
  {bus: 'build', delay: 300, event: 'artifact:pack', payload: {artifactPath: 'packages/core-data/build/artifact.tgz', packageName: 'core-data'}},
  {bus: 'build', delay: 200, event: 'complete', payload: {duration: 3200, packageName: 'core-data', version: '1.0.3'}},
  {bus: 'orchestration', delay: 50, event: 'package:complete', payload: {
    duration: 3200, level: 0, orchestrationId: 'sim-001', packageName: 'core-data', skipped: false, success: true,
  }},

  // ui-components finishes shortly after
  {bus: 'build', delay: 500, event: 'task:complete', payload: {packageName: 'ui-components', success: true, taskName: 'MetadataDeployTask'}},
  {bus: 'build', delay: 100, event: 'builder:complete', payload: {componentCount: 18, packageName: 'ui-components'}},
  {bus: 'build', delay: 50, event: 'validate:queued', payload: {operationId: 'deploy-002', operationType: 'deploy', packageName: 'ui-components'}},
  {bus: 'build', delay: 100, event: 'assemble:start', payload: {packageName: 'ui-components'}},
  {bus: 'build', delay: 300, event: 'artifact:pack', payload: {artifactPath: 'packages/ui-components/build/artifact.tgz', packageName: 'ui-components'}},
  {bus: 'build', delay: 200, event: 'complete', payload: {duration: 4100, packageName: 'ui-components', version: '2.5.1'}},
  {bus: 'orchestration', delay: 50, event: 'package:complete', payload: {
    duration: 4100, level: 0, orchestrationId: 'sim-001', packageName: 'ui-components', skipped: false, success: true,
  }},
  {bus: 'orchestration', delay: 100, event: 'level:complete', payload: {
    failed: [], level: 0, orchestrationId: 'sim-001', skipped: [], succeeded: ['core-data', 'ui-components'],
  }},

  // Level 1: apex-utils
  {bus: 'orchestration', delay: 100, event: 'level:start', payload: {
    level: 1, orchestrationId: 'sim-001',
    packageDetails: [{isManaged: false, name: 'apex-utils'}],
    packages: ['apex-utils'],
  }},
  {bus: 'build', delay: 100, event: 'start', payload: {packageName: 'apex-utils', packageType: 'Unlocked'}},
  {bus: 'build', delay: 200, event: 'stage:start', payload: {packageName: 'apex-utils'}},
  {bus: 'build', delay: 400, event: 'stage:complete', payload: {componentCount: 8, packageName: 'apex-utils'}},
  {bus: 'build', delay: 100, event: 'builder:start', payload: {packageName: 'apex-utils', packageType: 'Unlocked'}},
  {bus: 'build', delay: 200, event: 'create:start', payload: {packageName: 'apex-utils', versionNumber: '3.0.0'}},
  {bus: 'build', delay: 1000, event: 'create:progress', payload: {message: 'Initializing package version', packageName: 'apex-utils', status: 'InProgress'}},
  {bus: 'build', delay: 1500, event: 'create:complete', payload: {packageName: 'apex-utils', packageVersionId: '04t000000000001', versionNumber: '3.0.0'}},
  {bus: 'build', delay: 100, event: 'builder:complete', payload: {componentCount: 8, packageName: 'apex-utils'}},

  // apex-utils: post-build hooks
  {bus: 'build', delay: 100, event: 'hooks:start', payload: {
    hookCount: 3, hookNames: ['notify-slack', 'update-changelog', 'tag-release'], operation: 'build', packageName: 'apex-utils', timing: 'post',
  }},
  {bus: 'build', delay: 500, event: 'hook:complete', payload: {
    hookName: 'notify-slack', operation: 'build', packageName: 'apex-utils', timing: 'post',
  }},
  {bus: 'build', delay: 400, event: 'hook:complete', payload: {
    hookName: 'update-changelog', operation: 'build', packageName: 'apex-utils', timing: 'post',
  }},
  {bus: 'build', delay: 300, event: 'hook:complete', payload: {
    hookName: 'tag-release', operation: 'build', packageName: 'apex-utils', timing: 'post',
  }},
  {bus: 'build', delay: 50, event: 'hooks:complete', payload: {
    completedCount: 3, operation: 'build', packageName: 'apex-utils', timing: 'post',
  }},

  {bus: 'build', delay: 50, event: 'validate:queued', payload: {operationId: 'pvr-001', operationType: 'package-version-request', packageName: 'apex-utils'}},
  {bus: 'build', delay: 100, event: 'assemble:start', payload: {packageName: 'apex-utils'}},
  {bus: 'build', delay: 300, event: 'artifact:pack', payload: {artifactPath: 'packages/apex-utils/build/artifact.tgz', packageName: 'apex-utils'}},
  {bus: 'build', delay: 200, event: 'complete', payload: {duration: 4500, packageName: 'apex-utils', version: '3.0.0'}},
  {bus: 'orchestration', delay: 50, event: 'package:complete', payload: {
    duration: 4500, level: 1, orchestrationId: 'sim-001', packageName: 'apex-utils', skipped: false, success: true,
  }},
  {bus: 'orchestration', delay: 100, event: 'level:complete', payload: {
    failed: [], level: 1, orchestrationId: 'sim-001', skipped: [], succeeded: ['apex-utils'],
  }},
  {bus: 'orchestration', delay: 100, event: 'complete', payload: {
    orchestrationId: 'sim-001',
    results: [
      {duration: 3200, packageName: 'core-data', version: '1.2.0', skipped: false, success: true},
      {duration: 4100, packageName: 'ui-components', version: '2.1.0',  skipped: false, success: true},
      {duration: 4500, packageName: 'apex-utils', version: '3.5.2', skipped: false, success: true},
    ],
    totalDuration: 8800,
  }},
];

// ============================================================================
// Run
// ============================================================================

const speed = 2;

// ── Phase 1: Build ────────────────────────────────────────────────────────
// Play interleaved build+orchestration timeline (mirrors buildAll())
const buildRenderer = new BuildProgressRenderer({logger, mode: 'interactive'});
buildRenderer.attachTo(buildBus, orchestrationBus);

for (const entry of timeline) {
  const effectiveDelay = speed === 0 ? 0 : Math.round(entry.delay / speed);
  if (effectiveDelay > 0) {
    await new Promise(resolve => { setTimeout(resolve, effectiveDelay); });
  }
  const bus = entry.bus === 'build' ? buildBus : orchestrationBus;
  bus.emit(entry.event as any, entry.payload as any);
}

tr('BUILD TIMELINE LOOP FINISHED (buildAll has "returned")');

// Build summary — in prod this is the ✔ list logged by complete() during the
// build. Shown here right after the build, before validation starts.
renderBuildSummary(
  [
    {failed: false, packageName: 'core-data', skipped: false},
    {failed: false, packageName: 'ui-components', skipped: false},
    {failed: false, packageName: 'apex-utils', skipped: false},
  ],
  8800,
  logger,
);

// ── Phase 2: Validation ───────────────────────────────────────────────────
// Mirrors resolveValidationsInline(): bus + renderer created AFTER buildAll()
// returns. In prod the gap between buildAll() resolving and resolver.resolve()
// firing resolve:start is just a couple of fast awaits (tracer.shutdown,
// ProjectService.getInstance). We replicate that TIGHT coupling here — NO
// setImmediate — so the build Listr's fire-and-forget run() may NOT have
// resolved (end() not called, stdout still hijacked) when validation starts.
//
// TRANSITION_YIELDS: bump this to give the build Listr more time to tear down.
// 0 = tightest (prod-like). Try 0, then 1, then 5 to see the threshold.
const TRANSITION_YIELDS = Number(process.env.TRANSITION_YIELDS ?? 0);
for (let i = 0; i < TRANSITION_YIELDS; i++) {
  // eslint-disable-next-line no-await-in-loop
  await new Promise(resolve => { setImmediate(resolve); });
}
tr(`TRANSITION done (${TRANSITION_YIELDS} setImmediate yields) — starting validation`);

const validationBus = new ValidationEventBus();
const validationRenderer = new ValidationProgressRenderer('interactive', logger);
validationRenderer.attachTo(validationBus);

// Explicit lifecycle: begin() before work (spinner live), end() after (final paint).
await validationRenderer.begin(['core-data', 'ui-components', 'apex-utils']);

// Validation timeline (progress events only — begin() already started the UI):
//  - core-data + ui-components: deploy-style (source packages, no polling)
//    Both fire simultaneously — they deploy to the same org in one batch.
//  - apex-utils: polling-style (unlocked package, package-version-request)
const validationTimeline: TimelineEntry<ValidationEvents>[] = [
  // Deploy validation: install orchestrator runs, both source packages deploy
  // together, results come back as a batch via emitDeployResult()
  {
    delay: 2000,
    event: 'resolve:passed',
    payload: {checks: ['deploy'], componentsDeployed: 42, componentsTotal: 42, codeCoverage: 87, packageName: 'core-data'} as any,
  },
  {
    delay: 50,
    event: 'resolve:passed',
    payload: {checks: ['deploy'], componentsDeployed: 18, componentsTotal: 18, codeCoverage: 92, packageName: 'ui-components'} as any,
  },

  // Package-version-request: apex-utils polls the DevHub
  {
    delay: 500,
    event: 'resolve:status',
    payload: {packageName: 'apex-utils', status: 'polling'} as any,
  },
  {
    delay: 1200,
    event: 'resolve:status',
    payload: {attempt: 2, packageName: 'apex-utils', status: 'polling'} as any,
  },
  {
    delay: 1500,
    event: 'resolve:passed',
    payload: {checks: ['deploy', 'test', 'dependencies'], codeCoverage: 95, packageName: 'apex-utils'} as any,
  },

  {delay: 200, event: 'resolve:complete', payload: {failed: 0, passed: 3, timedOut: 0, total: 3}},
];

// ── Validation driver ──────────────────────────────────────────────────────
// The proper model (mirrors resolveValidationsInline):
//   await renderer.begin(names)   already called above — spinner is LIVE
//   run work (fires progress events)
//   await renderer.end()          final paint + summary BEFORE process.exit
//
// DRIVER=clean      (default) fires events on clean timers, drains naturally.
// DRIVER=realistic  runs work then process.exit(1) like this.error({exit:1}).
//                   Because begin() already made the spinner live and end()
//                   awaits the final paint, the result shows even before exit.
//   STARVE=1        block the loop during work (like a sync SDK path). The
//                   spinner is still live (begin() guaranteed it) and end()
//                   still paints the final state.
const DRIVER = process.env.DRIVER ?? 'clean';

if (DRIVER === 'realistic') {
  if (process.env.STARVE === '1') {
    tr('VALIDATION (realistic): STARVING event loop ~2.5s during work');
    const end = Date.now() + 2500;
    while (Date.now() < end) { /* sync block */ }
  } else {
    await new Promise(resolve => { setTimeout(resolve, 2500); });
  }
  tr('VALIDATION (realistic): work done, firing results');

  validationBus.emit('resolve:passed', {checks: ['deploy'], componentsDeployed: 42, componentsTotal: 42, codeCoverage: 87, packageName: 'core-data'} as any);
  validationBus.emit('resolve:passed', {checks: ['deploy'], componentsDeployed: 18, componentsTotal: 18, codeCoverage: 92, packageName: 'ui-components'} as any);
  validationBus.emit('resolve:failed', {checks: ['deploy', 'test'], componentsDeployed: 8, componentsTotal: 8, codeCoverage: 40, error: 'Apex Test Failure: StringFormatUtilityTest.testConvertUserName', packageName: 'apex-utils'} as any);
  validationBus.emit('resolve:complete', {failed: 1, passed: 2, timedOut: 0, total: 3} as any);

  // Paint the final state BEFORE exit (mirrors renderer.end() in prod).
  tr('VALIDATION (realistic): awaiting renderer.end() [final paint before exit]');
  await validationRenderer.end();

  // Mimic resolveValidationsInline()'s this.error(..., {exit: 1}) on failure.
  tr('VALIDATION (realistic): process.exit(1) (like this.error({exit:1}))');
  process.exit(1);
} else {
  const valSim = new EventSimulator(validationBus);
  await valSim.play(validationTimeline, {speed});
  await validationRenderer.end();
}

tr('VALIDATION FINISHED');