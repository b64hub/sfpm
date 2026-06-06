#!/usr/bin/env npx tsx
/**
 * Visual simulation of the new flat per-package build rendering.
 *
 * Run with: npx tsx packages/cli/test/ui/simulate-build.ts
 *
 * Demonstrates:
 * - Flat package-level Listr tasks (no level wrappers)
 * - Sub-tasks for build phases and validation queued
 * - Sub-tasks collapse on success, stay expanded on failure
 * - Post-build validation section via ValidationProgressRenderer
 * - Summary line instead of result box
 */
import type {ValidationEvents} from '@b64hub/sfpm-core';

import {BuildEventBus, OrchestrationEventBus, ValidationEventBus} from '@b64hub/sfpm-core';

import {BuildProgressRenderer} from '../../src/ui/build-progress-renderer.js';
import {ValidationProgressRenderer} from '../../src/ui/validation-progress-renderer.js';
import {renderBuildSummary} from '../../src/ui/build-summary.js';
import {EventSimulator, type TimelineEntry} from './event-simulator.js';

const logger = {
  error: (msg: Error | string) => console.error(msg),
  log: (msg: string) => console.log(msg),
};

// ============================================================================
// Setup: buses + renderers
// ============================================================================

const buildBus = new BuildEventBus();
const orchestrationBus = new OrchestrationEventBus('sim-001');
const validationBus = new ValidationEventBus();

const buildRenderer = new BuildProgressRenderer({logger, mode: 'interactive'});
buildRenderer.attachTo(buildBus, orchestrationBus);

const validationRenderer = new ValidationProgressRenderer('interactive', logger);
validationRenderer.attachTo(validationBus);

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
      {duration: 3200, packageName: 'core-data', skipped: false, success: true},
      {duration: 4100, packageName: 'ui-components', skipped: false, success: true},
      {duration: 4500, packageName: 'apex-utils', skipped: false, success: true},
    ],
    totalDuration: 8800,
  }},
];

// ============================================================================
// Validation timeline (post-build)
// ============================================================================

const validationTimeline: TimelineEntry<ValidationEvents>[] = [
  {delay: 300, event: 'resolve:start', payload: {packageNames: ['core-data', 'ui-components', 'apex-utils']}},
  {delay: 500, event: 'resolve:status', payload: {packageName: 'core-data', status: 'polling'} as any},
  {delay: 2000, event: 'resolve:passed', payload: {checks: ['deploy', 'test'], codeCoverage: 87, componentsDeployed: 42, componentsTotal: 42, packageName: 'core-data'} as any},
  {delay: 500, event: 'resolve:status', payload: {packageName: 'ui-components', status: 'polling'} as any},
  {delay: 2000, event: 'resolve:passed', payload: {checks: ['deploy', 'test'], codeCoverage: 92, componentsDeployed: 18, componentsTotal: 18, packageName: 'ui-components'} as any},
  {delay: 500, event: 'resolve:status', payload: {packageName: 'apex-utils', status: 'polling'} as any},
  {delay: 1500, event: 'resolve:passed', payload: {checks: ['deploy', 'test', 'dependencies'], codeCoverage: 95, packageName: 'apex-utils'} as any},
  {delay: 300, event: 'resolve:complete', payload: {failed: 0, passed: 3, timedOut: 0, total: 3}},
];

// ============================================================================
// Run
// ============================================================================

const speed = 2;

// Play interleaved build+orchestration timeline
for (const entry of timeline) {
  const effectiveDelay = speed === 0 ? 0 : Math.round(entry.delay / speed);
  if (effectiveDelay > 0) {
    await new Promise(resolve => { setTimeout(resolve, effectiveDelay); });
  }

  const bus = entry.bus === 'build' ? buildBus : orchestrationBus;
  bus.emit(entry.event as any, entry.payload as any);
}

// Play validation timeline
const valSim = new EventSimulator(validationBus);
await valSim.play(validationTimeline, {speed});

renderBuildSummary(
  [
    {failed: false, packageName: 'core-data', skipped: false},
    {failed: false, packageName: 'ui-components', skipped: false},
    {failed: false, packageName: 'apex-utils', skipped: false},
  ],
  8800,
  logger,
);
