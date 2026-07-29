/**
 * Large-scale build: 4 levels, 17 packages.
 *
 * Designed to stress-test the OrchestrationView layout:
 *
 *  Phase 1 — Level 0 (3 packages, with build steps)
 *  Phase 2 — Level 1 (3 packages, one failure with error detail)
 *  Phase 3 — Level 2 becomes active: all 8 packages pending
 *             → 3 visible queued + "⋯ 5 more queued" + "Level 3 — 3 waiting"
 *  Phase 4 — Level 2 packs start running in batches, truncation shrinks
 *  Phase 5 — Level 2 done, Level 3 runs and completes
 *  Phase 6 — build:complete(false) — failure from ui-kit propagates
 *  Phase 7 — validation runs on Level 0 packages
 */

type Event = Record<string, unknown> & {type: string};

// ---- helpers ----
const start  = (packageName: string): Event => ({packageName, status: 'running', type: 'build:package:status'});
const done   = (packageName: string, meta?: Record<string, string>): Event => ({
  packageName, status: 'success', type: 'build:package:status', ...(meta ? {meta} : {}),
});
const fail   = (packageName: string, detail: string): Event => ({
  detail, packageName, status: 'failed', type: 'build:package:status',
});
const step   = (packageName: string, name: string, status: string, detail?: string): Event =>
  ({
    packageName, status, step: name, type: 'build:package:step', ...(detail ? {detail} : {}),
  });

export const largeBuildEvents: Event[] = [
  // ── Setup ─────────────────────────────────────────────────────────────────
  {
    levels: [
      ['core-utils', 'shared-types', 'design-tokens'],
      ['ui-kit', 'auth-lib', 'api-client'],
      ['app-shell', 'app-portal', 'admin-console', 'notification-svc', 'analytics-svc', 'reporting-svc', 'audit-svc', 'monitoring-svc'],
      ['integration-tests', 'e2e-suite', 'regression-suite'],
    ],
    type: 'build:start',
  },

  // ── Phase 1: Level 0 — all succeed, core-utils shows build steps ──────────
  start('core-utils'),
  start('shared-types'),
  start('design-tokens'),

  step('core-utils',   'hooks:pre', 'running'),
  step('shared-types', 'stage',     'running'),
  step('core-utils',   'hooks:pre', 'success'),
  step('core-utils',   'stage',     'running'),
  step('shared-types', 'stage',     'success'),
  done('shared-types',   {components: '8',   hash: 'b2c3d4e'}),
  step('core-utils', 'stage', 'success'),
  done('core-utils',     {components: '12',  hash: 'a1b2c3d'}),
  done('design-tokens',  {components: '156', hash: 'c3d4e5f'}),

  // ── Phase 2: Level 1 — ui-kit fails, auth-lib + api-client succeed ────────
  start('ui-kit'),
  start('auth-lib'),
  start('api-client'),

  step('ui-kit',     'stage',     'running'),
  step('auth-lib',   'stage',     'running'),
  step('api-client', 'hooks:pre', 'running'),
  step('api-client', 'hooks:pre', 'success'),
  step('auth-lib',   'stage',     'success'),
  done('auth-lib',   {components: '34',  hash: 'd4e5f6a'}),

  step('ui-kit', 'stage', 'failed', "Cannot resolve '@sfpm/tokens'"),
  fail('ui-kit', "Cannot resolve '@sfpm/tokens'"),
  done('api-client', {components: '21',  hash: 'e5f6a7b'}),

  // ── Phase 3: Level 2 active — all 8 packages pending ─────────────────────
  // At this point the view shows:
  //   app-shell          queued   —
  //   app-portal         queued   —
  //   admin-console      queued   —
  //   ⋯ 5 more queued
  //   Level 3 — 3 waiting

  start('app-shell'),
  start('app-portal'),
  start('admin-console'),

  // ── Phase 4: Level 2 first batch running ──────────────────────────────────
  // busy=[app-shell, app-portal, admin-console]
  // queued=[notification-svc, analytics-svc, reporting-svc, audit-svc, monitoring-svc]
  // visible=3, hidden=2

  step('app-shell',     'stage', 'running'),
  step('admin-console', 'stage', 'running'),
  done('app-portal',     {components: '63',  hash: 'f6a7b8c'}),
  step('app-shell',     'stage', 'success'),
  done('app-shell',      {components: '127', hash: 'a7b8c9d'}),
  step('admin-console', 'stage', 'success'),
  done('admin-console',  {components: '89',  hash: 'b8c9d0e'}),

  start('notification-svc'),
  start('analytics-svc'),
  start('reporting-svc'),
  done('notification-svc', {components: '7',  hash: 'c9d0e1f'}),
  done('analytics-svc',    {components: '19', hash: 'd0e1f2a'}),

  start('audit-svc'),
  start('monitoring-svc'),
  done('reporting-svc',  {components: '14', hash: 'e1f2a3b'}),
  done('audit-svc',      {components: '9',  hash: 'f2a3b4c'}),
  done('monitoring-svc', {components: '11', hash: 'a3b4c5d'}),

  // ── Phase 5: Level 3 runs and completes ───────────────────────────────────
  start('integration-tests'),
  start('e2e-suite'),
  start('regression-suite'),
  done('integration-tests', {components: '203', hash: 'b4c5d6e'}),
  done('e2e-suite',         {components: '88',  hash: 'c5d6e7f'}),
  done('regression-suite',  {components: '141', hash: 'd6e7f8a'}),

  // ── Phase 6: build complete with failure ──────────────────────────────────
  {success: false, type: 'build:complete'},

  // ── Phase 7: validation (Level 0 packages) ────────────────────────────────
  {packages: ['core-utils', 'shared-types', 'design-tokens'], type: 'validation:start'},
  {packageName: 'core-utils',   status: 'running', type: 'validation:status'},
  {packageName: 'shared-types', status: 'running', type: 'validation:status'},
  {packageName: 'core-utils',   status: 'success', type: 'validation:status'},
  {packageName: 'design-tokens', status: 'running', type: 'validation:status'},
  {packageName: 'shared-types', status: 'success', type: 'validation:status'},
  {packageName: 'design-tokens', status: 'success', type: 'validation:status'},
];
