import { includeIgnoreFile } from '@eslint/compat'
import oclif from 'eslint-config-oclif'
import prettier from 'eslint-config-prettier'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import unicorn from 'eslint-plugin-unicorn'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const gitignorePath = path.resolve(__dirname, '.gitignore')

export default [
  includeIgnoreFile(gitignorePath),
  ...oclif,
  prettier,
  
  // Optional: Add any monorepo-wide rule overrides
  {
    files: ['packages/*/src/**/*.ts'],
    plugins: {
      unicorn,
    },
    rules: {
      'unicorn/filename-case': [
        'error',
        {
          'case': 'kebabCase'
        }
      ],
      // Example of other helpful monorepo overrides:
      '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_' }],
    }
  }
]