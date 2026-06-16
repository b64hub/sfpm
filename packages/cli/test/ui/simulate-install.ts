#!/usr/bin/env npx tsx
/**
 * Visual simulation of the flat per-package install rendering.
 *
 * Run with: npx tsx packages/cli/test/ui/simulate-install.ts
 *
 * Demonstrates:
 * - Flat package-level Listr tasks with rolling sub-task titles
 * - Hook phases rendered as single sub-tasks (pre-/post-install)
 * - Sub-tasks collapse on success, stay expanded on failure
 * - Concurrent packages within a level, sequential across levels
 */
import {InstallEventBus, OrchestrationEventBus} from '@b64hub/sfpm-core';

import {InstallProgressRenderer} from '../../src/ui/install-progress-renderer.js';

const logger = {
  error: (msg: Error | string) => console.error(msg),
  log: (msg: string) => console.log(msg),
};

// ============================================================================
// Setup: buses + renderer
// ============================================================================

const installBus = new InstallEventBus();
const orchestrationBus = new OrchestrationEventBus('sim-install-001');

const renderer = new InstallProgressRenderer({
  logger,
  mode: 'interactive',
  targetOrg: 'my-sandbox',
});
renderer.attachTo(installBus, orchestrationBus);

// ============================================================================
// Install + Orchestration timeline (interleaved, mirrors real event ordering)
// ============================================================================

type BusEvent = {bus: 'install' | 'orchestration'; delay: number; event: string; payload: any};

const timeline: BusEvent[] = [
  // Orchestrator starts
  {bus: 'orchestration', delay: 0, event: 'start', payload: {
    includeDependencies: true,
    orchestrationId: 'sim-install-001',
    packageNames: ['core-data', 'ui-components', 'apex-utils'],
    totalLevels: 2,
    totalPackages: 3,
  }},

  // Level 0: core-data + ui-components install concurrently
  {bus: 'orchestration', delay: 100, event: 'level:start', payload: {
    level: 0,
    orchestrationId: 'sim-install-001',
    packageDetails: [{isManaged: false, name: 'core-data'}, {isManaged: false, name: 'ui-components'}],
    packages: ['core-data', 'ui-components'],
  }},

  // core-data: start → pre-install hooks → deploy → post-install hooks → complete
  {bus: 'install', delay: 100, event: 'start', payload: {
    packageName: 'core-data', packageType: 'Source', targetOrg: 'my-sandbox', versionNumber: '1.0.3',
  }},
  {bus: 'install', delay: 50, event: 'start', payload: {
    packageName: 'ui-components', packageType: 'Source', targetOrg: 'my-sandbox', versionNumber: '2.5.1',
  }},

  // core-data: pre-install hooks
  {bus: 'install', delay: 200, event: 'hooks:start', payload: {
    hookCount: 2, hookNames: ['validate-schema', 'backup-data'], operation: 'install', packageName: 'core-data', timing: 'pre',
  }},
  {bus: 'install', delay: 800, event: 'hook:complete', payload: {
    hookName: 'validate-schema', operation: 'install', packageName: 'core-data', timing: 'pre',
  }},
  {bus: 'install', delay: 600, event: 'hook:complete', payload: {
    hookName: 'backup-data', operation: 'install', packageName: 'core-data', timing: 'pre',
  }},
  {bus: 'install', delay: 50, event: 'hooks:complete', payload: {
    completedCount: 2, operation: 'install', packageName: 'core-data', timing: 'pre',
  }},

  // ui-components: connection
  {bus: 'install', delay: 100, event: 'connection:start', payload: {
    orgType: 'sandbox', packageName: 'ui-components', username: 'admin@my-sandbox.org',
  }},
  {bus: 'install', delay: 500, event: 'connection:complete', payload: {
    orgId: '00D000000000001', packageName: 'ui-components', username: 'admin@my-sandbox.org',
  }},

  // core-data: deploy
  {bus: 'install', delay: 100, event: 'deploy:start', payload: {
    packageName: 'core-data', targetOrg: 'my-sandbox',
  }},
  {bus: 'install', delay: 800, event: 'deploy:progress', payload: {
    numberComponentsDeployed: 20, numberComponentsTotal: 42,
    packageName: 'core-data', status: 'InProgress',
  }},
  {bus: 'install', delay: 800, event: 'deploy:progress', payload: {
    numberComponentsDeployed: 42, numberComponentsTotal: 42,
    packageName: 'core-data', status: 'Succeeded',
  }},
  {bus: 'install', delay: 200, event: 'deploy:complete', payload: {
    numberComponentsDeployed: 42, packageName: 'core-data',
  }},

  // ui-components: deploy
  {bus: 'install', delay: 100, event: 'deploy:start', payload: {
    packageName: 'ui-components', targetOrg: 'my-sandbox',
  }},
  {bus: 'install', delay: 600, event: 'deploy:progress', payload: {
    numberComponentsDeployed: 10, numberComponentsTotal: 18,
    packageName: 'ui-components', status: 'InProgress',
  }},

  // core-data: post-install hooks
  {bus: 'install', delay: 200, event: 'hooks:start', payload: {
    hookCount: 1, hookNames: ['run-seed-data'], operation: 'install', packageName: 'core-data', timing: 'post',
  }},
  {bus: 'install', delay: 1000, event: 'hook:complete', payload: {
    hookName: 'run-seed-data', operation: 'install', packageName: 'core-data', timing: 'post',
  }},
  {bus: 'install', delay: 50, event: 'hooks:complete', payload: {
    completedCount: 1, operation: 'install', packageName: 'core-data', timing: 'post',
  }},

  // core-data: complete
  {bus: 'install', delay: 100, event: 'complete', payload: {
    packageName: 'core-data', source: 'artifact', targetOrg: 'my-sandbox', versionNumber: '1.0.3',
  }},
  {bus: 'orchestration', delay: 50, event: 'package:complete', payload: {
    duration: 4200, level: 0, orchestrationId: 'sim-install-001',
    packageName: 'core-data', skipped: false, success: true,
  }},

  // ui-components: finish deploy + complete
  {bus: 'install', delay: 400, event: 'deploy:progress', payload: {
    numberComponentsDeployed: 18, numberComponentsTotal: 18,
    packageName: 'ui-components', status: 'Succeeded',
  }},
  {bus: 'install', delay: 200, event: 'deploy:complete', payload: {
    numberComponentsDeployed: 18, packageName: 'ui-components',
  }},
  {bus: 'install', delay: 100, event: 'complete', payload: {
    packageName: 'ui-components', source: 'artifact', targetOrg: 'my-sandbox', versionNumber: '2.5.1',
  }},
  {bus: 'orchestration', delay: 50, event: 'package:complete', payload: {
    duration: 5100, level: 0, orchestrationId: 'sim-install-001',
    packageName: 'ui-components', skipped: false, success: true,
  }},
  {bus: 'orchestration', delay: 100, event: 'level:complete', payload: {
    failed: [], level: 0, orchestrationId: 'sim-install-001',
    skipped: [], succeeded: ['core-data', 'ui-components'],
  }},

  // Level 1: apex-utils (unlocked package — version install)
  {bus: 'orchestration', delay: 100, event: 'level:start', payload: {
    level: 1, orchestrationId: 'sim-install-001',
    packageDetails: [{isManaged: false, name: 'apex-utils'}],
    packages: ['apex-utils'],
  }},
  {bus: 'install', delay: 100, event: 'start', payload: {
    packageName: 'apex-utils', packageType: 'Unlocked', targetOrg: 'my-sandbox', versionNumber: '3.0.0',
  }},
  {bus: 'install', delay: 200, event: 'connection:start', payload: {
    orgType: 'sandbox', packageName: 'apex-utils', username: 'admin@my-sandbox.org',
  }},
  {bus: 'install', delay: 400, event: 'connection:complete', payload: {
    orgId: '00D000000000001', packageName: 'apex-utils', username: 'admin@my-sandbox.org',
  }},

  // apex-utils: pre-install hooks
  {bus: 'install', delay: 200, event: 'hooks:start', payload: {
    hookCount: 3, hookNames: ['check-deps', 'feature-flags', 'clear-cache'], operation: 'install', packageName: 'apex-utils', timing: 'pre',
  }},
  {bus: 'install', delay: 500, event: 'hook:complete', payload: {
    hookName: 'check-deps', operation: 'install', packageName: 'apex-utils', timing: 'pre',
  }},
  {bus: 'install', delay: 400, event: 'hook:complete', payload: {
    hookName: 'feature-flags', operation: 'install', packageName: 'apex-utils', timing: 'pre',
  }},
  {bus: 'install', delay: 300, event: 'hook:complete', payload: {
    hookName: 'clear-cache', operation: 'install', packageName: 'apex-utils', timing: 'pre',
  }},
  {bus: 'install', delay: 50, event: 'hooks:complete', payload: {
    completedCount: 3, operation: 'install', packageName: 'apex-utils', timing: 'pre',
  }},

  // apex-utils: version install
  {bus: 'install', delay: 200, event: 'version:start', payload: {
    packageName: 'apex-utils', packageVersionId: '04t000000000001',
  }},
  {bus: 'install', delay: 1000, event: 'version:progress', payload: {
    packageName: 'apex-utils', status: 'IN_PROGRESS',
  }},
  {bus: 'install', delay: 1500, event: 'version:complete', payload: {
    packageName: 'apex-utils', packageVersionId: '04t000000000001',
  }},

  // apex-utils: post-install hooks
  {bus: 'install', delay: 200, event: 'hooks:start', payload: {
    hookCount: 2, hookNames: ['assign-perms', 'smoke-test'], operation: 'install', packageName: 'apex-utils', timing: 'post',
  }},
  {bus: 'install', delay: 700, event: 'hook:complete', payload: {
    hookName: 'assign-perms', operation: 'install', packageName: 'apex-utils', timing: 'post',
  }},
  {bus: 'install', delay: 500, event: 'hook:complete', payload: {
    hookName: 'smoke-test', operation: 'install', packageName: 'apex-utils', timing: 'post',
  }},
  {bus: 'install', delay: 50, event: 'hooks:complete', payload: {
    completedCount: 2, operation: 'install', packageName: 'apex-utils', timing: 'post',
  }},

  // apex-utils: complete
  {bus: 'install', delay: 100, event: 'complete', payload: {
    packageName: 'apex-utils', packageVersionId: '04t000000000001',
    source: 'subscriber', targetOrg: 'my-sandbox', versionNumber: '3.0.0',
  }},
  {bus: 'orchestration', delay: 50, event: 'package:complete', payload: {
    duration: 5800, level: 1, orchestrationId: 'sim-install-001',
    packageName: 'apex-utils', skipped: false, success: true,
  }},
  {bus: 'orchestration', delay: 100, event: 'level:complete', payload: {
    failed: [], level: 1, orchestrationId: 'sim-install-001',
    skipped: [], succeeded: ['apex-utils'],
  }},
  {bus: 'orchestration', delay: 100, event: 'complete', payload: {
    orchestrationId: 'sim-install-001',
    results: [
      {duration: 4200, packageName: 'core-data', skipped: false, success: true},
      {duration: 5100, packageName: 'ui-components', skipped: false, success: true},
      {duration: 5800, packageName: 'apex-utils', skipped: false, success: true},
    ],
    totalDuration: 11100,
  }},
];

// ============================================================================
// Run
// ============================================================================

const speed = 2;

for (const entry of timeline) {
  const effectiveDelay = speed === 0 ? 0 : Math.round(entry.delay / speed);
  if (effectiveDelay > 0) {
    await new Promise(resolve => { setTimeout(resolve, effectiveDelay); });
  }

  const bus = entry.bus === 'install' ? installBus : orchestrationBus;
  bus.emit(entry.event as any, entry.payload as any);
}
