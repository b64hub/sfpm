#!/usr/bin/env npx tsx
/**
 * Visual simulation of the ValidationProgressRenderer.
 *
 * Run with: npx tsx packages/cli/test/ui/simulate-validation.ts
 *
 * Adjust `speed` to iterate faster (2 = 2x speed, 0 = instant).
 */
import type {ValidationEvents} from '@b64hub/sfpm-core';

import {ValidationEventBus} from '@b64hub/sfpm-core';

import {ValidationProgressRenderer} from '../../src/ui/validation-progress-renderer.js';
import {EventSimulator, TimelineEntry} from './event-simulator.js';

// ============================================================================
// Timeline: mixed source + unlocked package validation
// ============================================================================

const timeline: TimelineEntry<ValidationEvents>[] = [
  {
    delay: 0,
    event: 'resolve:start',
    payload: {packageNames: ['core-data', 'ui-components', 'analytics']},
  },
  {
    delay: 500,
    event: 'resolve:status',
    payload: {packageName: 'core-data', status: 'polling'} as any,
  },
  {
    delay: 800,
    event: 'resolve:status',
    payload: {packageName: 'ui-components', status: 'queued', waitingFor: 'core-data'} as any,
  },
  {
    delay: 1200,
    event: 'resolve:status',
    payload: {attempt: 2, packageName: 'core-data', status: 'polling'} as any,
  },
  {
    delay: 2000,
    event: 'resolve:passed',
    payload: {checks: ['deploy', 'test'], codeCoverage: 87, packageName: 'core-data'} as any,
  },
  {
    delay: 500,
    event: 'resolve:status',
    payload: {packageName: 'ui-components', status: 'polling'} as any,
  },
  {
    delay: 300,
    event: 'resolve:status',
    payload: {packageName: 'analytics', status: 'polling'} as any,
  },
  {
    delay: 1500,
    event: 'resolve:passed',
    payload: {checks: ['deploy', 'test', 'dependencies'], codeCoverage: 92, packageName: 'analytics'} as any,
  },
  {
    delay: 2000,
    event: 'resolve:failed',
    payload: {codeCoverage: 68, error: 'Coverage 68% below required 75%', packageName: 'ui-components'} as any,
  },
  {
    delay: 300,
    event: 'resolve:complete',
    payload: {failed: 1, passed: 2, timedOut: 0, total: 3},
  },
];

// ============================================================================
// Run
// ============================================================================

const bus = new ValidationEventBus();
const renderer = new ValidationProgressRenderer('interactive', {
  error: (msg) => console.error(msg),
  log: (msg) => console.log(msg),
});
renderer.attachTo(bus);

const simulator = new EventSimulator(bus);
await simulator.play(timeline, {speed: 1});
