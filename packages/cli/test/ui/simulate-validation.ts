#!/usr/bin/env npx tsx
/**
 * Visual simulation of the ValidationProgressRenderer.
 *
 * Run with: npx tsx packages/cli/test/ui/simulate-validation.ts
 *
 * Demonstrates:
 * - Per-package Listr spinners (all packages deploying concurrently)
 * - Results arriving independently as deploys complete
 * - (N/N deployed, X% coverage) annotation on pass
 * - Error annotation on failure
 * - Final pass/fail summary line
 *
 * Adjust `speed` to iterate faster (2 = 2×, 0 = instant).
 */
import type {ValidationEvents} from '@b64hub/sfpm-core';

import {ValidationEventBus} from '@b64hub/sfpm-core';

import {ValidationProgressRenderer} from '../../src/ui/validation-progress-renderer.js';
import {EventSimulator, type TimelineEntry} from './event-simulator.js';

// ============================================================================
// Timeline: deploy-style validation (packages deploy in parallel, no polling)
//
// All four packages start simultaneously. Results arrive as each deploy
// finishes — independently, without intermediate status updates.
// ============================================================================

const packageNames = ['core-data', 'ui-components', 'analytics', 'apex-utils'];

const timeline: TimelineEntry<ValidationEvents>[] = [
  // core-data finishes first — full metadata deploy + coverage
  {
    delay: 1500,
    event: 'resolve:passed',
    payload: {
      checks: ['deploy'],
      codeCoverage: 87,
      componentsDeployed: 42,
      componentsTotal: 42,
      packageName: 'core-data',
    } as any,
  },

  // analytics finishes next
  {
    delay: 800,
    event: 'resolve:passed',
    payload: {
      checks: ['deploy'],
      codeCoverage: 92,
      componentsDeployed: 24,
      componentsTotal: 24,
      packageName: 'analytics',
    } as any,
  },

  // ui-components fails — coverage below threshold
  {
    delay: 700,
    event: 'resolve:failed',
    payload: {
      checks: ['deploy'],
      codeCoverage: 68,
      componentsDeployed: 15,
      componentsTotal: 15,
      error: 'Coverage 68% below required 75%',
      packageName: 'ui-components',
    } as any,
  },

  // apex-utils passes — config/metadata package, no coverage measured
  {
    delay: 600,
    event: 'resolve:passed',
    payload: {
      checks: ['deploy'],
      componentsDeployed: 31,
      componentsTotal: 31,
      packageName: 'apex-utils',
    } as any,
  },

  // Summary
  {
    delay: 300,
    event: 'resolve:complete',
    payload: {failed: 1, passed: 3, timedOut: 0, total: 4},
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

// Explicit lifecycle: start the spinner (await until live), play progress
// events, then finish (final paint + summary) — mirrors resolveValidationsInline.
await renderer.begin(packageNames);

const simulator = new EventSimulator(bus);
await simulator.play(timeline, {speed: 1});

await renderer.end();
