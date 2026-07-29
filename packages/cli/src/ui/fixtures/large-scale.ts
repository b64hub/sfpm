/**
 * Large-scale build: 4 levels, 17 packages.
 *
 * Designed to stress-test the OrchestrationView layout:
 *
 *  Phase 1 — Level 0 (3 packages, with build steps; all enter 'validating')
 *  Phase 2 — Level 1 (3 packages, one failure; validating packages visible above)
 *  Phase 3 — Level 2 becomes active: all 8 packages pending
 *             → 3 visible queued + "⋯ 5 more queued" + "Level 3 — 3 waiting"
 *  Phase 4 — Level 2 packs start running in batches, truncation shrinks
 *  Phase 5 — Level 2 done, Level 3 runs and completes
 *  Phase 6 — orchestration:complete(false) — failure from ui-kit propagates
 *  Phase 7 — validation resolves for Level 0 packages (folded into main tree)
 */

type Event = Record<string, unknown> & {type: string};

// ---- helpers ----------------------------------------------------------------

const running = (packageName: string): Event =>
  ({packageName, type: 'package:running'});

const done = (packageName: string, meta?: Record<string, string>): Event =>
  ({
    packageName, status: 'success', type: 'package:complete', ...(meta ? {meta} : {}),
  });

const validating = (packageName: string): Event[] => [
  {packageName, status: 'validating', type: 'package:complete'},
  {packageName, step: 'validate', type: 'step:start'},
];

const fail = (packageName: string, detail: string): Event =>
  ({
    detail, packageName, status: 'failed', type: 'package:complete',
  });

/** Emits step:start or step:complete depending on status. */
const step = (packageName: string, name: string, status: 'failed' | 'running' | 'success', detail?: string): Event => {
  const type = status === 'running' ? 'step:start' : 'step:complete';
  return {
    packageName,
    step: name,
    type,
    ...(status === 'running' ? {} : {status}),
    ...(detail ? {detail} : {}),
  };
};

const validationPoll = (packageName: string, attempt: number): Event =>
  ({
    detail: `polling (attempt ${attempt})`, packageName, step: 'validate', type: 'step:update',
  });

const validationPass = (packageName: string, meta: Record<string, string>): Event[] => [
  {
    packageName, status: 'success', step: 'validate', type: 'step:complete',
  },
  {
    meta, packageName, status: 'success', type: 'package:complete',
  },
];

// ---- fixture ----------------------------------------------------------------

export const largeBuildEvents: Event[] = [
  // ── Setup ──────────────────────────────────────────────────────────────────
  {
    levels: [
      ['core-utils', 'shared-types', 'design-tokens'],
      ['ui-kit', 'auth-lib', 'api-client'],
      ['app-shell', 'app-portal', 'admin-console', 'notification-svc', 'analytics-svc', 'reporting-svc', 'audit-svc', 'monitoring-svc'],
      ['integration-tests', 'e2e-suite', 'regression-suite'],
    ],
    type: 'orchestration:init',
  },

  // ── Phase 1: Level 0 — all succeed, then enter async validation ────────────
  running('core-utils'),
  running('shared-types'),
  running('design-tokens'),

  step('core-utils',   'pre-hooks', 'running'),
  step('shared-types', 'stage',     'running'),
  step('core-utils',   'pre-hooks', 'success'),
  step('core-utils',   'stage',     'running'),
  step('shared-types', 'stage',     'success'),
  step('core-utils',   'stage',     'success'),

  // All three enter 'validating' — stays in live area during subsequent levels.
  ...validating('core-utils'),
  ...validating('shared-types'),
  ...validating('design-tokens'),

  // ── Phase 2: Level 1 — ui-kit fails, auth-lib + api-client succeed ─────────
  // core-utils / shared-types / design-tokens are 'validating' and visible above.
  running('ui-kit'),
  running('auth-lib'),
  running('api-client'),

  step('ui-kit',     'stage',     'running'),
  step('auth-lib',   'stage',     'running'),
  step('api-client', 'pre-hooks', 'running'),
  step('api-client', 'pre-hooks', 'success'),
  step('auth-lib',   'stage',     'success'),
  done('auth-lib',   {components: '34',  hash: 'd4e5f6a', version: '4.9.0'}),

  step('ui-kit', 'stage', 'failed', "Cannot resolve '@sfpm/tokens'"),
  fail('ui-kit', "Cannot resolve '@sfpm/tokens'"),
  done('api-client', {components: '21',  hash: 'e5f6a7b'}),

  // ── Phase 3: Level 2 active — all 8 packages pending ──────────────────────
  // At this point the view shows:
  //   core-utils     validating  (from prior level)
  //   shared-types   validating  (from prior level)
  //   design-tokens  validating  (from prior level)
  //   app-shell      queued
  //   app-portal     queued
  //   admin-console  queued
  //   ⋯ 5 more queued
  //   Level 3 — 3 waiting

  running('app-shell'),
  running('app-portal'),
  running('admin-console'),

  // ── Phase 4: Level 2 first batch running ───────────────────────────────────
  step('app-shell',     'stage', 'running'),
  step('admin-console', 'stage', 'running'),
  done('app-portal',     {components: '63',  hash: 'f6a7b8c', version: '0.1.0'}),
  step('app-shell',     'stage', 'success'),
  done('app-shell',      {components: '127', hash: 'a7b8c9d', version: '2.2.0'}),
  step('admin-console', 'stage', 'success'),
  done('admin-console',  {components: '89',  hash: 'b8c9d0e', version: '1.2.0'}),

  running('notification-svc'),
  running('analytics-svc'),
  running('reporting-svc'),
  done('notification-svc', {components: '7',  hash: 'c9d0e1f', version: '3.7.0'}),
  done('analytics-svc',    {components: '19', hash: 'd0e1f2a'}),

  running('audit-svc'),
  running('monitoring-svc'),
  done('reporting-svc',  {components: '14', hash: 'e1f2a3b', version: '2.2.0'}),
  done('audit-svc',      {components: '9',  hash: 'f2a3b4c', version: '5.1.0'}),
  done('monitoring-svc', {components: '11', hash: 'a3b4c5d', version: '0.1.0'}),

  // ── Phase 5: Level 3 runs and completes ────────────────────────────────────
  running('integration-tests'),
  running('e2e-suite'),
  running('regression-suite'),
  done('integration-tests', {components: '203', hash: 'b4c5d6e', version: '1.15.0'}),
  done('e2e-suite',         {components: '88',  hash: 'c5d6e7f', version: '2.2.0'}),
  done('regression-suite',  {components: '141', hash: 'd6e7f8a', version: '2.3.0'}),

  // ── Phase 6: orchestration complete (failure — ui-kit propagates) ──────────
  {success: false, type: 'orchestration:complete'},

  // ── Phase 7: validation resolves for Level 0 packages ─────────────────────
  // Packages have been in 'validating' since Phase 1. They now resolve.
  validationPoll('core-utils',    1),
  validationPoll('shared-types',  1),
  validationPoll('design-tokens', 1),
  validationPoll('core-utils',    2),
  ...validationPass('core-utils',   {components: '12',  hash: 'a1b2c3d', version: '1.5.0'}),
  validationPoll('design-tokens',   2),
  ...validationPass('shared-types', {components: '8',   hash: 'b2c3d4e', version: '2.1.0'}),
  ...validationPass('design-tokens', {components: '156', hash: 'c3d4e5f', version: '8.0.1'}),
];
