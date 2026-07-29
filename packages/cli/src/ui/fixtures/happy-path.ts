/**
 * Two-level build (core-utils + shared-types in parallel, then app-shell),
 * followed by validation of the source packages.
 */
export const happyPathEvents = [
  {levels: [['core-utils', 'shared-types'], ['app-shell']], type: 'build:start'},
  {packageName: 'core-utils', status: 'running', type: 'build:package:status'},
  {
    packageName: 'core-utils', status: 'running', step: 'hooks:pre', type: 'build:package:step',
  },
  {
    packageName: 'core-utils', status: 'success', step: 'hooks:pre', type: 'build:package:step',
  },
  {
    packageName: 'core-utils', status: 'success', step: 'stage', type: 'build:package:step',
  },
  {
    meta: {components: '12', hash: 'a1b2c3d'},   packageName: 'core-utils', status: 'success', type: 'build:package:status',
  },
  {
    meta: {components: '3',  hash: 'b2c3d4e'}, packageName: 'shared-types', status: 'success', type: 'build:package:status',
  },
  {packageName: 'app-shell',    status: 'running', type: 'build:package:status'},
  {
    meta: {components: '47', hash: 'c3d4e5f'},    packageName: 'app-shell', status: 'success', type: 'build:package:status',
  },
  {success: true, type: 'build:complete'},
  {packages: ['core-utils', 'shared-types'], type: 'validation:start'},
  {packageName: 'core-utils', status: 'success', type: 'validation:status'},
  {packageName: 'shared-types', status: 'success', type: 'validation:status'},
];
