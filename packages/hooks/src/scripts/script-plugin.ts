import {HookContext, LifecycleHooks} from '@b64/sfpm-core';
import {Org} from '@salesforce/core';

import type {ScriptDefinition, ScriptHooksOptions, ScriptType} from './types.js';

import {ScriptRunner} from './script-runner.js';

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
  const failOnError = options.failOnError ?? true;
  const preScripts = options.scripts.filter(s => s.timing === 'pre');
  const postScripts = options.scripts.filter(s => (s.timing ?? 'post') === 'post');

  const hooks = [];

  if (preScripts.length > 0) {
    hooks.push({

      async handler(context: HookContext) {
        await executeScripts(preScripts, 'pre', context, failOnError);
      },
      phase: 'install',
      timing: 'pre' as const,
    });
  }

  if (postScripts.length > 0) {
    hooks.push({

      async handler(context: HookContext) {
        await executeScripts(postScripts, 'post', context, failOnError);
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

// ============================================================================
// Helpers
// ============================================================================

/**
 * Execute a list of scripts sequentially within a hook handler.
 */
async function executeScripts(
  scripts: ScriptDefinition[],
  timing: 'post' | 'pre',
  context: HookContext,
  failOnError: boolean,
): Promise<void> {
  const {logger, packageName} = context;
  const projectDir = (context.projectDir as string | undefined) ?? process.cwd();
  const targetOrg = resolveTargetOrg(context);
  const runner = new ScriptRunner(logger);

  for (const script of scripts) {
    if (script.packageName && script.packageName !== packageName) continue;

    const scriptType = resolveScriptType(script);
    logger?.info(`Script [${timing}]: running ${scriptType} script '${script.path}' for '${packageName}'`);

    // eslint-disable-next-line no-await-in-loop -- sequential execution required
    const result = await runner.run(script, scriptType, {
      custom: script.env,
      packageName: packageName as string | undefined,
      projectDir,
      stagingDirectory: context.stagingDirectory as string | undefined,
      targetOrg,
    }, projectDir);

    if (!result.success) {
      const message = `Script '${script.path}' failed:\n${result.stderr || result.stdout}`;

      if (failOnError) {
        throw new Error(message);
      }

      logger?.warn(message);
    }
  }
}

/**
 * Resolve the target org username from the hook context.
 */
function resolveTargetOrg(context: HookContext): string | undefined {
  const {org} = context;

  if (org instanceof Org) {
    return org.getUsername();
  }

  return undefined;
}
