/**
 * One level with two packages; one fails mid-build, the other succeeds.
 * Build completes with success:false — no validation phase.
 */
export const partialFailureEvents = [
  {type: 'build:start', levels: [['ui-kit', 'core-utils']]},
  {type: 'build:package:status', packageName: 'ui-kit', status: 'running'},
  {type: 'build:package:status', packageName: 'core-utils', status: 'running'},
  {type: 'build:package:step', packageName: 'ui-kit', step: 'stage', status: 'running'},
  {type: 'build:package:step', packageName: 'ui-kit', step: 'stage', status: 'failed', detail: 'TS2307: Cannot find module'},
  {type: 'build:package:status', packageName: 'ui-kit', status: 'failed', detail: 'TS2307: Cannot find module'},
  {type: 'build:package:status', packageName: 'core-utils', status: 'success'},
  {type: 'build:complete', success: false},
];
