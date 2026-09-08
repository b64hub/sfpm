import * as esbuild from 'esbuild';

/**
 * Entrypoint -> action directory. Each `action.yml` runs `index.mjs` from its
 * own directory, so the bundle must be committed next to it — GitHub resolves
 * `runs.main` relative to the action directory and cannot read outside it.
 */
const actions = {
  'build-main': 'build',
  'build-turbo-aggregate-main': 'build-turbo-aggregate',
  'build-validation-main': 'build-validation',
  'clean-pool-main': 'clean-pool',
  'deploy-main': 'deploy',
  'fill-pool-main': 'fill-pool',
  'install-main': 'install',
  'validate-main': 'validate-pr',
};

await Promise.all(
  Object.entries(actions).map(([entry, dir]) =>
    esbuild.build({
      // Bundled CJS deps (@salesforce/core and friends) call `require` at
      // runtime, which does not exist in an ESM output without this shim.
      banner: {
        js: "import {createRequire as ___createRequire} from 'node:module';const require = ___createRequire(import.meta.url);",
      },
      bundle: true,
      entryPoints: [`src/${entry}.ts`],
      format: 'esm',
      // Keep output readable: unminified + sourcemaps is what makes these
      // bundles auditable for action-whitelisting review. Do not enable minify.
      minify: false,
      outfile: `${dir}/index.mjs`,
      platform: 'node',
      sourcemap: true,
      target: 'node20',
    }),
  ),
);

console.log(`Bundled ${Object.keys(actions).length} actions: ${Object.values(actions).join(', ')}`);
