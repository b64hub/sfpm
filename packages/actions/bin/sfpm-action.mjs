#!/usr/bin/env node
/**
 * Dispatcher invoked by the composite actions, from the shared pinned runtime:
 *   <runtime>/node_modules/.bin/sfpm-action <action-name>
 *
 * Inputs arrive as INPUT_* environment variables mapped in each action.yml,
 * so the entrypoints keep using @actions/core `getInput`/`setOutput` unchanged.
 */

/** Action name -> compiled entrypoint. A fixed map, never a path built from argv. */
const ACTIONS = {
  'build': 'build-main.js',
  'build-turbo-aggregate': 'build-turbo-aggregate-main.js',
  'build-validation': 'build-validation-main.js',
  'clean-pool': 'clean-pool-main.js',
  'deploy': 'deploy-main.js',
  'fill-pool': 'fill-pool-main.js',
  'install': 'install-main.js',
  'validate-pr': 'validate-main.js',
};

const name = process.argv[2];
const entrypoint = Object.hasOwn(ACTIONS, name ?? '') ? ACTIONS[name] : undefined;

if (!entrypoint) {
  console.error(
    `sfpm-action: unknown action '${name ?? ''}'.\n`
    + `Expected one of: ${Object.keys(ACTIONS).join(', ')}`,
  );
  process.exit(1);
}

// Each entrypoint runs its work on import and sets process.exitCode itself.
await import(new URL(`../dist/${entrypoint}`, import.meta.url).href);
