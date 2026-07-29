/**
 * One level with two packages; ui-kit fails mid-build, core-utils succeeds.
 * Orchestration completes with success:false — no validation phase.
 */
export const partialFailureEvents = [
  {levels: [['ui-kit', 'core-utils']], type: 'orchestration:init'},

  {packageName: 'ui-kit',    type: 'package:running'},
  {packageName: 'core-utils', type: 'package:running'},

  {packageName: 'ui-kit', step: 'stage', type: 'step:start'},
  {
    detail: 'TS2307: Cannot find module', packageName: 'ui-kit', status: 'failed', step: 'stage', type: 'step:complete',
  },
  {
    detail: 'TS2307: Cannot find module', packageName: 'ui-kit', status: 'failed', type: 'package:complete',
  },

  {
    meta: {components: '12', hash: 'a1b2c3d'}, packageName: 'core-utils', status: 'success', type: 'package:complete',
  },

  {success: false, type: 'orchestration:complete'},
];
