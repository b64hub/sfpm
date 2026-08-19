import * as esbuild from 'esbuild';

const sharedOptions = {
    bundle: true,
    external: [
        // Node built-ins are available in the Actions runner
    ],
    format: 'esm',
    minify: false,
    platform: 'node',
    sourcemap: true,
    target: 'node20',
};

await Promise.all([
    esbuild.build({
        ...sharedOptions,
        entryPoints: ['src/validate-main.ts'],
        outfile: 'dist/validate-main.js',
    }),
    esbuild.build({
        ...sharedOptions,
        entryPoints: ['src/fill-pool-main.ts'],
        outfile: 'dist/fill-pool-main.js',
    }),
    esbuild.build({
        ...sharedOptions,
        entryPoints: ['src/clean-pool-main.ts'],
        outfile: 'dist/clean-pool-main.js',
    }),
    esbuild.build({
        ...sharedOptions,
        entryPoints: ['src/build-main.ts'],
        outfile: 'dist/build-main.js',
    }),
    esbuild.build({
        ...sharedOptions,
        entryPoints: ['src/build-validation-main.ts'],
        outfile: 'dist/build-validation-main.js',
    }),
    esbuild.build({
        ...sharedOptions,
        entryPoints: ['src/build-turbo-aggregate-main.ts'],
        outfile: 'dist/build-turbo-aggregate-main.js',
    }),
    esbuild.build({
        ...sharedOptions,
        entryPoints: ['src/install-main.ts'],
        outfile: 'dist/install-main.js',
    }),
    esbuild.build({
        ...sharedOptions,
        entryPoints: ['src/deploy-main.ts'],
        outfile: 'dist/deploy-main.js',
    }),
]);

console.log('Bundled dist/validate-main.js');
console.log('Bundled dist/fill-pool-main.js');
console.log('Bundled dist/clean-pool-main.js');
console.log('Bundled dist/build-main.js');
console.log('Bundled dist/build-validation-main.js');
console.log('Bundled dist/build-turbo-aggregate-main.js');
console.log('Bundled dist/install-main.js');
console.log('Bundled dist/deploy-main.js');
