import { defineConfig } from 'vitest/config';

export default defineConfig({
    test: {
        environment: 'node',
        // Vitest handles .js extensions in ESM by default, but we might need this if it fails
        // alias: {
        //     '/^(\\..*)\\.js$/': '$1.ts'
        // }
    },
});
