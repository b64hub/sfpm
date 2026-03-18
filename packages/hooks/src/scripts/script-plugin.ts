import {HookContext, LifecycleHooks} from '@b64/sfpm-core';

import type {ScriptDefinition, ScriptHooksOptions, ScriptType} from './types.js';

const EXTENSION_MAP: Record<string, ScriptType> = {
  '.apex': 'apex',
  '.js': 'javascript',
  '.sh': 'shell',
  '.ts': 'typescript',
};

/**
 * Infer script type from file extension when not explicitly provided.
 */
function resolveScriptType(script: ScriptDefinition): ScriptType {
  if (script.type) return script.type;

  const ext = script.path.slice(script.path.lastIndexOf('.'));
  const inferred = EXTENSION_MAP[ext];
  if (!inferred) {
    throw new Error(`Script: unable to infer script type from extension '${ext}' for '${script.path}'`);
  }

  return inferred;
}

/**
 * Creates lifecycle hooks for running custom scripts during installation.
 *
 * Registers hooks on `install:pre` and `install:post` that execute
 * user-defined scripts. Supports shell scripts (`.sh`), TypeScript
 * (`.ts`), JavaScript (`.js`), and anonymous Apex (`.apex`).
 *
 * Scripts are executed in order of definition. Each script receives
 * environment variables from the hook context (target org, package name,
 * etc.) in addition to any custom `env` overrides.
 *
 * @param options - Hook configuration options
 * @returns A LifecycleHooks instance to pass to `defineConfig({ hooks: [...] })`
 *
 * @example
 * ```typescript
 * // sfpm.config.ts
 * import { defineConfig } from '@b64/sfpm-core';
 * import { scriptHooks } from '@b64/sfpm-hooks';
 *
 * export default defineConfig({
 *   hooks: [
 *     scriptHooks({
 *       scripts: [
 *         { path: 'scripts/pre-deploy.sh', timing: 'pre' },
 *         { path: 'scripts/seed-data.ts', timing: 'post' },
 *         { path: 'scripts/activate.apex', timing: 'post' },
 *       ],
 *     }),
 *   ],
 * });
 * ```
 */
export function scriptHooks(options: ScriptHooksOptions): LifecycleHooks {
  const preScripts = options.scripts.filter(s => s.timing === 'pre');
  const postScripts = options.scripts.filter(s => (s.timing ?? 'post') === 'post');

  const hooks = [];

  if (preScripts.length > 0) {
    hooks.push({
      async handler(context: HookContext) {
        const {logger, packageName} = context;

        for (const script of preScripts) {
          if (script.packageName && script.packageName !== packageName) continue;

          const scriptType = resolveScriptType(script);
          logger?.info(`Script [pre]: running ${scriptType} script '${script.path}' for '${packageName}'`);

          // TODO: Execute shell scripts via child_process.spawn
          // TODO: Execute TypeScript scripts via jiti or tsx
          // TODO: Execute JavaScript scripts via child_process.fork
          // TODO: Execute Apex scripts via Tooling API anonymous execute
          // TODO: Inject environment variables (target org, package info)
          // TODO: Enforce script.timeout
          // TODO: Handle failures based on options.failOnError
        }
      },
      phase: 'install',
      timing: 'pre' as const,
    });
  }

  if (postScripts.length > 0) {
    hooks.push({
      async handler(context: HookContext) {
        const {logger, packageName} = context;

        for (const script of postScripts) {
          if (script.packageName && script.packageName !== packageName) continue;

          const scriptType = resolveScriptType(script);
          logger?.info(`Script [post]: running ${scriptType} script '${script.path}' for '${packageName}'`);

          // TODO: Execute shell scripts via child_process.spawn
          // TODO: Execute TypeScript scripts via jiti or tsx
          // TODO: Execute JavaScript scripts via child_process.fork
          // TODO: Execute Apex scripts via Tooling API anonymous execute
          // TODO: Inject environment variables (target org, package info)
          // TODO: Enforce script.timeout
          // TODO: Handle failures based on options.failOnError
        }
      },
      phase: 'install',
      timing: 'post' as const,
    });
  }

  return {
    hooks,
    name: 'scripts',
  };
}
