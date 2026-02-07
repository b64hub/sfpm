import { includeIgnoreFile } from '@eslint/compat';
import stylistic from '@stylistic/eslint-plugin';
import prettier from 'eslint-config-prettier';
import oclif from 'eslint-config-oclif';

import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const gitignorePath = path.resolve(__dirname, '.gitignore');

export default [
  includeIgnoreFile(gitignorePath),
  ...oclif,
  prettier,
  {
    files: ['packages/*/src/**/*.ts'],
    rules: {
      'unicorn/filename-case': [
        'error',
        {
          case: 'kebabCase',
        },
      ],
      '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_' }],
      'unicorn/prefer-event-target': 'off', // EventEmitter is more appropriate for Node.js
      '@typescript-eslint/no-explicit-any': 'warn', // Allow any but warn about it
    },
  },
];
