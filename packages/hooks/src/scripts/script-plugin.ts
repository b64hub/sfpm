import {HookContext, LifecycleHooks, resolveHookConfig} from '@b64hub/sfpm-core';

import type {ScriptDefinition, ScriptHooksOptions, ScriptType} from './types.js';

import {ScriptNotFoundError} from './executors/npm-executor.js';
import {ScriptRunner} from './script-runner.js';

const EXTENSION_MAP: Record<string, ScriptType> = {
  '.apex': 'apex',
  '.js': 'javascript',
  '.sh': 'shell',
  '.ts': 'typescript',
};

/**
 * Per-package hook overrides for script execution.
 *
 * Placed under `packageOptions.hooks["scripts"]` in `sfdx-project.json`:
 * ```jsonc
 * {
 *   "hooks": {
 *     "scripts": {
 *       "pre": ["scripts/setup.sh"],
 *       "post": ["scripts/seed.ts", "scripts/activate.apex", "npm:seed-data"]
 *     }
 *   }
 * }
 * ```
 *
 * Values can be plain paths (strings), `npm:<script-name>` references, or
 * full {@link ScriptDefinition} objects.
 */
interface ScriptHookOverrides {
  /** Scripts to run after installation. */
  post?: Array<ScriptDefinition | string>;
  /** Scripts to run before installation. */
  pre?: Array<ScriptDefinition | string>;
}

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
 * (`.ts`), JavaScript (`.js`), anonymous Apex (`.apex`), and npm
 * scripts from `package.json`.
 *
 * Scripts are resolved from **two sources** (merged):
 *
 * 1. **Global options** — `scriptHooks({ scripts: [...] })` in `sfpm.config.ts`
 * 2. **Per-package overrides** — `packageOptions.hooks["scripts"].pre/post`
 *
 * Per-package scripts are appended after global scripts at each timing.
 * When a per-package `hooks["scripts"]` is set to `false`, the hook is
 * skipped entirely for that package (handled by the lifecycle engine).
 *
 * @param options - Hook configuration options
 * @returns A LifecycleHooks instance to pass to `defineConfig({ hooks: [...] })`
 *
 * @example
 * ```typescript
 * // sfpm.config.ts
 * import { defineConfig } from '@b64hub/sfpm-core';
 * import { scriptHooks } from '@b64hub/sfpm-hooks';
 *
 * export default defineConfig({
 *   hooks: [
 *     scriptHooks({
 *       scripts: [
 *         { path: 'scripts/pre-deploy.sh', timing: 'pre' },
 *         { path: 'scripts/seed-data.ts', timing: 'post' },
 *         { path: 'scripts/activate.apex', timing: 'post' },
 *         { path: 'seed-data', type: 'npm', timing: 'post' },
 *       ],
 *     }),
 *   ],
 * });
 * ```
 */
export function scriptHooks(options: ScriptHooksOptions): LifecycleHooks {
  const failOnError = options.failOnError ?? true;
  const globalPreScripts = options.scripts.filter(s => s.timing === 'pre');
  const globalPostScripts = options.scripts.filter(s => (s.timing ?? 'post') === 'post');

  return {
    hooks: [
      {
        async handler(context: HookContext) {
          const scripts = resolveScripts(context, 'pre', globalPreScripts);
          if (scripts.length === 0) return;
          await executeScripts(scripts, 'pre', context, failOnError);
        },
        operation: 'install',
        timing: 'pre' as const,
      },
      {
        async handler(context: HookContext) {
          const scripts = resolveScripts(context, 'post', globalPostScripts);
          if (scripts.length === 0) return;
          await executeScripts(scripts, 'post', context, failOnError);
        },
        operation: 'install',
        timing: 'post' as const,
      },
    ],
    name: 'scripts',
  };
}

// ============================================================================
// Helpers
// ============================================================================

/**
 * Resolve the final script list for a given timing by merging:
 * 1. Global scripts from `sfpm.config.ts` options (already filtered by timing)
 * 2. Per-package overrides from `packageOptions.hooks["scripts"].pre/post`
 */
function resolveScripts(
  context: HookContext,
  timing: 'post' | 'pre',
  globalScripts: ScriptDefinition[],
): ScriptDefinition[] {
  const {config} = resolveHookConfig<ScriptHookOverrides>(context, 'scripts');
  const overrides = (timing === 'pre' ? config.pre : config.post) ?? [];
  const packageScripts = normalizeToDefinitions(overrides, timing);

  return [...globalScripts, ...packageScripts];
}

/**
 * Normalise mixed arrays of `string | ScriptDefinition` into full `ScriptDefinition[]`.
 *
 * Strings prefixed with `npm:` are treated as npm script references
 * (e.g. `"npm:seed-data"` → `{ path: 'seed-data', type: 'npm' }`).
 */
function normalizeToDefinitions(
  entries: Array<ScriptDefinition | string>,
  timing: 'post' | 'pre',
): ScriptDefinition[] {
  return entries.map(entry => {
    if (typeof entry !== 'string') return entry;

    if (entry.startsWith('npm:')) {
      return {path: entry.slice(4), timing, type: 'npm' as const};
    }

    return {path: entry, timing};
  });
}

/**
 * Execute a list of scripts sequentially within a hook handler.
 */
async function executeScripts(
  scripts: ScriptDefinition[],
  timing: 'post' | 'pre',
  context: HookContext,
  failOnError: boolean,
): Promise<void> {
  const {logger, sfpmPackage} = context;
  const packageName = sfpmPackage.name;
  const packagePath = sfpmPackage.packageDirectory ?? '';
  const {projectDir} = context;
  const runner = new ScriptRunner(logger);

  for (const script of scripts) {
    if (script.packageName && script.packageName !== packageName) continue;

    // Per-script stage filtering
    const currentStage = context.stage;
    if (script.stages && script.stages.length > 0 && !script.stages.includes(currentStage)) {
      logger?.debug(`Script [${timing}]: skipping '${script.path}' — stage '${currentStage}' not in [${script.stages.join(', ')}]`);
      continue;
    }

    const scriptType = resolveScriptType(script);

    logger?.info(`Script [${timing}]: running ${scriptType} script '${script.path}' for '${packageName}'`);

    try {
      // eslint-disable-next-line no-await-in-loop -- sequential execution required
      const result = await runner.run(script, scriptType, {
        custom: script.env,
        packageName,
        packagePath,
        projectDir,
        stagingDirectory: sfpmPackage.workingDirectory,
        targetOrg: context.targetOrg,
      });

      if (!result.success) {
        const message = `Script '${script.path}' failed:\n${result.stderr || result.stdout}`;

        if (failOnError) {
          throw new Error(message);
        }

        logger?.warn(message);
      }
    } catch (error) {
      if (error instanceof ScriptNotFoundError) {
        logger?.debug(`Script [${timing}]: skipping npm script '${script.path}' — ${error.message}`);
        continue;
      }

      throw error;
    }
  }
}
