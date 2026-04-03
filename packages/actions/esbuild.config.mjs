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
        entryPoints: ['src/main.ts'],
        outfile: 'dist/main.js',
    }),
    esbuild.build({
        ...sharedOptions,
        entryPoints: ['src/provision-pool-main.ts'],
        outfile: 'dist/provision-pool-main.js',
    }),
    esbuild.build({
        ...sharedOptions,
        entryPoints: ['src/build-main.ts'],
        outfile: 'dist/build-main.js',
    }),
    esbuild.build({
        ...sharedOptions,
        entryPoints: ['src/build-resume-main.ts'],
        outfile: 'dist/build-resume-main.js',
    }),
]);

console.log('Bundled dist/main.js');
console.log('Bundled dist/provision-pool-main.js');
console.log('Bundled dist/build-main.js');
console.log('Bundled dist/build-resume-main.js');
