import {includeIgnoreFile} from '@eslint/compat';
import stylistic from '@stylistic/eslint-plugin';
import oclif from 'eslint-config-oclif';
import prettier from 'eslint-config-prettier';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

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
      '@typescript-eslint/no-explicit-any': 'warn', // Allow any but warn about it
      '@typescript-eslint/no-unused-vars': ['warn', {argsIgnorePattern: '^_'}],
      '@stylistic/indent': 'warn',
      '@stylistic/indent-binary-ops': ['error', 2],
      'unicorn/filename-case': [
        'error',
        {
          case: 'kebabCase',
        },
      ],
      'unicorn/prefer-event-target': 'off', // EventEmitter is more appropriate for Node.js
      'unicorn/prefer-ternary': 'off', // Ternary can reduce readability in some cases
    },
  },
];
