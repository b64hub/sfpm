import {HookContext, LifecycleHooks, resolveHookConfig} from '@b64/sfpm-core';
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
 * Per-package hook overrides for script execution.
 *
 * Placed under `packageOptions.hooks["scripts"]` in `sfdx-project.json`:
 * ```jsonc
 * {
 *   "hooks": {
 *     "scripts": {
 *       "pre": ["scripts/setup.sh"],
 *       "post": ["scripts/seed.ts", "scripts/activate.apex"]
 *     }
 *   }
 * }
 * ```
 *
 * Values can be plain paths (strings) or full {@link ScriptDefinition} objects.
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
 * (`.ts`), JavaScript (`.js`), and anonymous Apex (`.apex`).
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
 */
function normalizeToDefinitions(
  entries: Array<ScriptDefinition | string>,
  timing: 'post' | 'pre',
): ScriptDefinition[] {
  return entries.map(entry =>
    typeof entry === 'string' ? {path: entry, timing} : entry);
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
  const {logger, packageName} = context;
  const projectDir = (context.projectDir as string | undefined) ?? process.cwd();
  const targetOrg = resolveTargetOrg(context);
  const runner = new ScriptRunner(logger);

  for (const script of scripts) {
    if (script.packageName && script.packageName !== packageName) continue;

    // Per-script stage filtering
    const currentStage = context.stage as string | undefined;
    if (script.stages && script.stages.length > 0 && currentStage && !script.stages.includes(currentStage)) {
      logger?.debug(`Script [${timing}]: skipping '${script.path}' — stage '${currentStage}' not in [${script.stages.join(', ')}]`);
      continue;
    }

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
