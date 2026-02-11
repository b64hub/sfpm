import {includeIgnoreFile} from '@eslint/compat';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

import rootConfig from '../../eslint.config.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const gitignorePath = path.resolve(__dirname, '.gitignore');

export default [
  includeIgnoreFile(gitignorePath),
  ...rootConfig,

  {
    files: ['src/**/*.ts'],
    rules: {
      '@typescript-eslint/explicit-function-return-type': 'warn',
      'no-console': 'error', // Libraries shouldn't use console
    },
  },
];
