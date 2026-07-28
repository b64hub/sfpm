/**
 * One level with two packages; one fails mid-build, the other succeeds.
 * Build completes with success:false — no validation phase.
 */
export const partialFailureEvents = [
  {levels: [['ui-kit', 'core-utils']], type: 'build:start'},
  {packageName: 'ui-kit', status: 'running', type: 'build:package:status'},
  {packageName: 'core-utils', status: 'running', type: 'build:package:status'},
  {
    packageName: 'ui-kit', status: 'running', step: 'stage', type: 'build:package:step',
  },
  {
    detail: 'TS2307: Cannot find module', packageName: 'ui-kit', status: 'failed', step: 'stage', type: 'build:package:step',
  },
  {
    detail: 'TS2307: Cannot find module', packageName: 'ui-kit', status: 'failed', type: 'build:package:status',
  },
  {packageName: 'core-utils', status: 'success', type: 'build:package:status'},
  {success: false, type: 'build:complete'},
];
