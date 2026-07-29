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
 */

type Event = Record<string, unknown> & {type: string};

// ---- helpers ----
const start  = (packageName: string): Event => ({packageName, status: 'running', type: 'build:package:status'});
const done   = (packageName: string): Event => ({packageName, status: 'success', type: 'build:package:status'});
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
  done('shared-types'),
  step('core-utils', 'stage', 'success'),
  done('core-utils'),
  done('design-tokens'),

  // ── Phase 2: Level 1 — ui-kit fails, auth-lib + api-client succeed ────────
  start('ui-kit'),
  start('auth-lib'),
  start('api-client'),

  step('ui-kit',     'stage',     'running'),
  step('auth-lib',   'stage',     'running'),
  step('api-client', 'hooks:pre', 'running'),
  step('api-client', 'hooks:pre', 'success'),
  step('auth-lib',   'stage',     'success'),
  done('auth-lib'),

  step('ui-kit', 'stage', 'failed', "Cannot resolve '@sfpm/tokens'"),
  fail('ui-kit', "Cannot resolve '@sfpm/tokens'"),
  done('api-client'),

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
  done('app-portal'),
  step('app-shell',     'stage', 'success'),
  done('app-shell'),
  step('admin-console', 'stage', 'success'),
  done('admin-console'),

  start('notification-svc'),
  start('analytics-svc'),
  start('reporting-svc'),
  done('notification-svc'),
  done('analytics-svc'),

  start('audit-svc'),
  start('monitoring-svc'),
  done('reporting-svc'),
  done('audit-svc'),
  done('monitoring-svc'),

  // ── Phase 5: Level 3 runs and completes ───────────────────────────────────
  start('integration-tests'),
  start('e2e-suite'),
  start('regression-suite'),
  done('integration-tests'),
  done('e2e-suite'),
  done('regression-suite'),

  // ── Phase 6: build complete with failure ──────────────────────────────────
  {success: false, type: 'build:complete'},
];
