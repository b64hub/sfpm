#!/usr/bin/env npx tsx
/**
 * Visual simulation of the BuildProgressRenderer + ValidationProgressRenderer.
 *
 * Run with: npx tsx packages/cli/test/ui/simulate-build.ts
 *
 * Demonstrates a two-package orchestrated build followed by validation,
 * with the result box deferred until after validation completes.
 */
import type {BuildEvents, OrchestrationEvents, ValidationEvents} from '@b64hub/sfpm-core';

import {BuildEventBus, OrchestrationEventBus, ValidationEventBus} from '@b64hub/sfpm-core';

import {BuildProgressRenderer} from '../../src/ui/build-progress-renderer.js';
import {ValidationProgressRenderer} from '../../src/ui/validation-progress-renderer.js';
import {EventSimulator, TimelineEntry} from './event-simulator.js';

const logger = {
  error: (msg: Error | string) => console.error(msg),
  log: (msg: string) => console.log(msg),
};

// ============================================================================
// Build timeline
// ============================================================================

const buildTimeline: TimelineEntry<BuildEvents>[] = [
  // -- Package: core-data (source) --
  {delay: 0, event: 'start', payload: {packageName: 'core-data', packageType: 'Source'} as any},
  {delay: 200, event: 'stage:start', payload: {packageName: 'core-data'} as any},
  {delay: 300, event: 'stage:complete', payload: {componentCount: 42, packageName: 'core-data'} as any},
  {delay: 100, event: 'builder:start', payload: {packageName: 'core-data', packageType: 'Source'} as any},
  {delay: 200, event: 'task:start', payload: {packageName: 'core-data', taskName: 'MetadataDeployTask'} as any},
  {delay: 1500, event: 'task:complete', payload: {packageName: 'core-data', taskName: 'MetadataDeployTask'} as any},
  {delay: 100, event: 'builder:complete', payload: {packageName: 'core-data'} as any},
  {delay: 100, event: 'assemble:start', payload: {packageName: 'core-data'} as any},
  {delay: 300, event: 'artifact:pack', payload: {artifactPath: 'packages/core-data/build/artifact.tgz', packageName: 'core-data'} as any},
  {delay: 200, event: 'assemble:complete', payload: {packageName: 'core-data'} as any},
  {delay: 100, event: 'complete', payload: {packageName: 'core-data'} as any},

  // -- Package: ui-components (unlocked) --
  {delay: 300, event: 'start', payload: {packageName: 'ui-components', packageType: 'Unlocked'} as any},
  {delay: 100, event: 'connection:start', payload: {packageName: 'ui-components', targetOrg: 'devhub@example.com'} as any},
  {delay: 400, event: 'connection:complete', payload: {orgId: '00D123456789', packageName: 'ui-components', username: 'devhub@example.com'} as any},
  {delay: 100, event: 'builder:start', payload: {packageName: 'ui-components', packageType: 'Unlocked'} as any},
  {delay: 200, event: 'create:start', payload: {packageName: 'ui-components'} as any},
  {delay: 1000, event: 'create:progress', payload: {message: 'Initializing package version create request', packageName: 'ui-components', status: 'InProgress'} as any},
  {delay: 1500, event: 'create:complete', payload: {packageName: 'ui-components', packageVersionId: '04t000000000001', subscriberPackageVersionId: '04t000000000001'} as any},
  {delay: 100, event: 'builder:complete', payload: {packageName: 'ui-components'} as any},
  {delay: 100, event: 'assemble:start', payload: {packageName: 'ui-components'} as any},
  {delay: 300, event: 'artifact:pack', payload: {artifactPath: 'packages/ui-components/build/artifact.tgz', packageName: 'ui-components'} as any},
  {delay: 200, event: 'assemble:complete', payload: {packageName: 'ui-components'} as any},
  {delay: 100, event: 'complete', payload: {packageName: 'ui-components', packageVersionId: '04t000000000001'} as any},
];

// ============================================================================
// Orchestration timeline
// ============================================================================

const orchestrationTimeline: TimelineEntry<OrchestrationEvents>[] = [
  {
    delay: 0,
    event: 'start',
    payload: {
      includeDependencies: true,
      orchestrationId: 'sim-001',
      packageNames: ['core-data', 'ui-components'],
      totalLevels: 2,
      totalPackages: 2,
    } as any,
  },
  {
    delay: 100,
    event: 'level:start',
    payload: {
      level: 0,
      orchestrationId: 'sim-001',
      packageDetails: [{isManaged: false, name: 'core-data'}],
      packages: ['core-data'],
    } as any,
  },
  {
    delay: 3300, // after core-data build completes
    event: 'package:complete',
    payload: {
      duration: 3200,
      level: 0,
      orchestrationId: 'sim-001',
      packageName: 'core-data',
      skipped: false,
      success: true,
    } as any,
  },
  {
    delay: 100,
    event: 'level:complete',
    payload: {
      failed: [],
      level: 0,
      orchestrationId: 'sim-001',
      skipped: [],
      succeeded: ['core-data'],
    } as any,
  },
  {
    delay: 100,
    event: 'level:start',
    payload: {
      level: 1,
      orchestrationId: 'sim-001',
      packageDetails: [{isManaged: false, name: 'ui-components'}],
      packages: ['ui-components'],
    } as any,
  },
  {
    delay: 4200, // after ui-components build completes
    event: 'package:complete',
    payload: {
      duration: 4100,
      level: 1,
      orchestrationId: 'sim-001',
      packageName: 'ui-components',
      skipped: false,
      success: true,
    } as any,
  },
  {
    delay: 100,
    event: 'level:complete',
    payload: {
      failed: [],
      level: 1,
      orchestrationId: 'sim-001',
      skipped: [],
      succeeded: ['ui-components'],
    } as any,
  },
  {
    delay: 100,
    event: 'complete',
    payload: {
      orchestrationId: 'sim-001',
      results: [
        {duration: 3200, packageName: 'core-data', skipped: false, success: true},
        {duration: 4100, packageName: 'ui-components', skipped: false, success: true},
      ],
      totalDuration: 7500,
    } as any,
  },
];

// ============================================================================
// Validation timeline (runs after build)
// ============================================================================

const validationTimeline: TimelineEntry<ValidationEvents>[] = [
  {delay: 300, event: 'resolve:start', payload: {packageNames: ['core-data', 'ui-components']}},
  {delay: 500, event: 'resolve:status', payload: {packageName: 'core-data', status: 'polling'} as any},
  {delay: 800, event: 'resolve:status', payload: {packageName: 'ui-components', status: 'queued', waitingFor: 'core-data'} as any},
  {delay: 2000, event: 'resolve:passed', payload: {checks: ['deploy', 'test'], codeCoverage: 87, componentsDeployed: 42, componentsTotal: 42, packageName: 'core-data'} as any},
  {delay: 500, event: 'resolve:status', payload: {packageName: 'ui-components', status: 'polling'} as any},
  {delay: 2000, event: 'resolve:passed', payload: {checks: ['deploy', 'test', 'dependencies'], codeCoverage: 92, componentsDeployed: 18, componentsTotal: 18, packageName: 'ui-components'} as any},
  {delay: 300, event: 'resolve:complete', payload: {failed: 0, passed: 2, timedOut: 0, total: 2}},
];

// ============================================================================
// Run
// ============================================================================

const buildBus = new BuildEventBus();
const orchestrationBus = new OrchestrationEventBus('sim-001');
const validationBus = new ValidationEventBus();

const buildRenderer = new BuildProgressRenderer({
  deferResultBox: true,
  logger,
  mode: 'interactive',
});
buildRenderer.attachTo(buildBus, orchestrationBus);

const validationRenderer = new ValidationProgressRenderer('interactive', logger);
validationRenderer.attachTo(validationBus);

const buildSim = new EventSimulator(buildBus);
const orchSim = new EventSimulator(orchestrationBus);
const valSim = new EventSimulator(validationBus);

// Play build + orchestration in parallel, then validation, then show result box
await Promise.all([
  buildSim.play(buildTimeline, {speed: 2}),
  orchSim.play(orchestrationTimeline, {speed: 2}),
]);

await valSim.play(validationTimeline, {speed: 2});
buildRenderer.showResultBox();
