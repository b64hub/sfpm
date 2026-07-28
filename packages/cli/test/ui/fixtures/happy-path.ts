/**
 * Two-level build (core-utils + shared-types in parallel, then app-shell),
 * followed by validation of the source packages.
 */
export const happyPathEvents = [
  {type: 'build:start', levels: [['core-utils', 'shared-types'], ['app-shell']]},
  {type: 'build:package:status', packageName: 'core-utils', status: 'running'},
  {type: 'build:package:step', packageName: 'core-utils', step: 'hooks:pre', status: 'running'},
  {type: 'build:package:step', packageName: 'core-utils', step: 'hooks:pre', status: 'success'},
  {type: 'build:package:step', packageName: 'core-utils', step: 'stage', status: 'success'},
  {type: 'build:package:status', packageName: 'core-utils', status: 'success'},
  {type: 'build:package:status', packageName: 'shared-types', status: 'success'},
  {type: 'build:package:status', packageName: 'app-shell', status: 'running'},
  {type: 'build:package:status', packageName: 'app-shell', status: 'success'},
  {type: 'build:complete', success: true},
  {type: 'validation:start', packages: ['core-utils', 'shared-types']},
  {type: 'validation:status', packageName: 'core-utils', status: 'success'},
  {type: 'validation:status', packageName: 'shared-types', status: 'success'},
];
