#!/usr/bin/env node
/**
 * Dispatcher for the published npm CLI (`sfpm-action <name>`). The GitHub
 * Actions run the committed bundle directly via `runs.main:` and no longer
 * use this file.
 *
 * Inputs arrive as INPUT_* environment variables automatically in native
 * actions, so the entrypoints keep using @actions/core `getInput`/`setOutput`
 * unchanged.
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
