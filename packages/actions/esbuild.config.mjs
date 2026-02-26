import * as esbuild from 'esbuild';

await esbuild.build({
    bundle: true,
    entryPoints: ['src/main.ts'],
    external: [
        // Node built-ins are available in the Actions runner
    ],
    format: 'esm',
    minify: false,
    outfile: 'dist/main.js',
    platform: 'node',
    sourcemap: true,
    target: 'node20',
});

console.log('Bundled dist/main.js');
