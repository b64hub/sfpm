/**
 * Two-level build: core-utils + shared-types in parallel (Level 0),
 * then app-shell (Level 1).
 *
 * Level 0 packages go through async validation — they stay non-terminal
 * (status: 'validating') while app-shell builds, then resolve after
 * orchestration:complete. Exercises the validation-folding flow.
 */
export const happyPathEvents = [
  {levels: [['core-utils', 'shared-types'], ['app-shell']], type: 'orchestration:init'},

  // ── Level 0 ───────────────────────────────────────────────────────────────
  {packageName: 'core-utils',   type: 'package:running'},
  {packageName: 'shared-types', type: 'package:running'},

  {packageName: 'core-utils', step: 'pre-hooks', type: 'step:start'},
  {
    packageName: 'core-utils', status: 'success', step: 'pre-hooks', type: 'step:complete',
  },
  {packageName: 'core-utils', step: 'stage',     type: 'step:start'},
  {packageName: 'shared-types', step: 'stage',   type: 'step:start'},
  {
    packageName: 'shared-types', status: 'success',   step: 'stage', type: 'step:complete',
  },
  {
    packageName: 'core-utils',   status: 'success',   step: 'stage', type: 'step:complete',
  },

  // Build done — both need async validation, so they enter 'validating' instead of 'success'.
  {packageName: 'core-utils',   status: 'validating', type: 'package:complete'},
  {packageName: 'core-utils',   step: 'validate',     type: 'step:start'},
  {packageName: 'shared-types', status: 'validating', type: 'package:complete'},
  {packageName: 'shared-types', step: 'validate',     type: 'step:start'},

  // ── Level 1 ───────────────────────────────────────────────────────────────
  // Builds while core-utils + shared-types are still validating.
  {packageName: 'app-shell', type: 'package:running'},
  {
    meta: {components: '47', hash: 'c3d4e5f', version: '3.0.0'}, packageName: 'app-shell', status: 'success', type: 'package:complete',
  },

  // ── Orchestration complete (build done; validation still in flight) ────────
  {success: true, type: 'orchestration:complete'},

  // ── Validation resolves ───────────────────────────────────────────────────
  {
    detail: 'polling (attempt 1)', packageName: 'core-utils',   step: 'validate', type: 'step:update',
  },
  {
    detail: 'polling (attempt 1)', packageName: 'shared-types', step: 'validate', type: 'step:update',
  },
  {
    detail: 'polling (attempt 2)', packageName: 'core-utils',   step: 'validate', type: 'step:update',
  },

  {
    packageName: 'core-utils',   status: 'success', step: 'validate', type: 'step:complete',
  },
  {
    meta: {components: '12', hash: 'a1b2c3d', version: '1.2.0'}, packageName: 'core-utils',   status: 'success', type: 'package:complete',
  },

  {
    packageName: 'shared-types', status: 'success', step: 'validate', type: 'step:complete',
  },
  {
    meta: {components: '3',  hash: 'b2c3d4e', version: '0.8.0'}, packageName: 'shared-types', status: 'success', type: 'package:complete',
  },
];
