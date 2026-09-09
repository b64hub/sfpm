import {HookContext, LifecycleHooks, resolveHookConfig} from '@b64hub/sfpm-core';
import path from 'node:path';

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
 *
 * Non-npm paths here are resolved relative to the **package's own directory**
 * (next to its `package.json`), not the project root — see {@link resolveScripts}.
 * `packageName` is meaningless on a per-package override (it's already scoped
 * to this package) and is ignored with a warning.
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
 * Creates lifecycle hooks for running custom scripts during build and installation.
 *
 * Registers hooks on `build:pre`/`build:post` and `install:pre`/`install:post`
 * that execute user-defined scripts. Supports shell scripts (`.sh`), TypeScript
 * (`.ts`), JavaScript (`.js`), anonymous Apex (`.apex`), and npm
 * scripts from `package.json`.
 *
 * Scripts are resolved from **two sources** (merged), with different path rules:
 *
 * 1. **Global options** — `scriptHooks({ scripts: [...] })` in `sfpm.config.ts`.
 *    Paths are relative to the **project root** of whichever project the CLI
 *    is currently running against (the monorepo for build/deploy, or the
 *    consuming project for install) — never bundled into a package artifact.
 * 2. **Per-package overrides** — `packageOptions.hooks["scripts"].pre/post`.
 *    Paths are relative to that **package's own directory** (next to its
 *    `package.json`). Pre-build/deploy scripts resolve against the live source
 *    directory; post-build and artifact-install scripts resolve against the
 *    package's staged/packed source (mirroring the package's configured
 *    `sfpm.path`), where `SourceCopyStep` already copies them for free —
 *    no separate script-assembly step needed.
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

  const preHandler = async (context: HookContext) => {
    const scripts = resolveScripts(context, 'pre', globalPreScripts);
    if (scripts.length === 0) return;
    await executeScripts(scripts, 'pre', context, failOnError);
  };

  const postHandler = async (context: HookContext) => {
    const scripts = resolveScripts(context, 'post', globalPostScripts);
    if (scripts.length === 0) return;
    await executeScripts(scripts, 'post', context, failOnError);
  };

  return {
    hooks: [
      {handler: preHandler, operation: 'build', timing: 'pre' as const},
      {handler: postHandler, operation: 'build', timing: 'post' as const},
      {handler: preHandler, operation: 'install', timing: 'pre' as const},
      {handler: postHandler, operation: 'install', timing: 'post' as const},
    ],
    name: 'scripts',
  };
}

// ============================================================================
// Helpers
// ============================================================================

/**
 * A resolved script tagged with its origin, so `executeScripts` can apply
 * origin-specific rules (e.g. ignoring `packageName` on package overrides).
 */
interface ResolvedScript {
  isPackageOverride: boolean;
  script: ScriptDefinition;
}

/**
 * Resolve the final script list for a given timing by merging:
 * 1. Global scripts from `sfpm.config.ts` options (already filtered by timing,
 *    left project-root-relative — resolved later by the executors)
 * 2. Per-package overrides from `packageOptions.hooks["scripts"].pre/post`
 *    (resolved here to an absolute path under `packageBaseDir`)
 */
function resolveScripts(
  context: HookContext,
  timing: 'post' | 'pre',
  globalScripts: ScriptDefinition[],
): ResolvedScript[] {
  const {config} = resolveHookConfig<ScriptHookOverrides>(context, 'scripts');
  const overrides = (timing === 'pre' ? config.pre : config.post) ?? [];
  const packageBaseDir = resolvePackageScriptBaseDir(context, timing);
  const packageScripts = normalizeToDefinitions(overrides, timing)
  .map(script => resolvePackageScriptPath(script, packageBaseDir));

  return [
    ...globalScripts.map(script => ({isPackageOverride: false, script})),
    ...packageScripts.map(script => ({isPackageOverride: true, script})),
  ];
}

/**
 * Whether `provider` represents an already-built/packed artifact rather than
 * live source. True only for artifact installs, where `getPackageBuildDirectory`
 * and `getPackageDir` point at the same extracted directory (no separate
 * `dist/` staging step exists post-install).
 */
function isArtifactInstall(context: HookContext): boolean {
  const {provider, sfpmPackage} = context;
  const buildDir = provider.getPackageBuildDirectory(sfpmPackage.name);
  return Boolean(buildDir) && buildDir === provider.getPackageDir(sfpmPackage.name);
}

/**
 * Base directory for resolving a **per-package** script's relative path.
 *
 * Per-package scripts live next to the package's own `package.json`. Before
 * the package has been built/packed (build:pre, or install from local source),
 * that's the live package directory. After staging (build:post) or when
 * installing a published artifact, `SourceCopyStep` has already copied the
 * package directory's content into the staged/packed source directory
 * (mirroring the package's configured `sfpm.path`) for free — so scripts
 * resolve there instead.
 */
function resolvePackageScriptBaseDir(context: HookContext, timing: 'post' | 'pre'): string | undefined {
  const {operation, provider, sfpmPackage} = context;
  const useBuiltSource = (operation === 'build' && timing === 'post')
    || (operation === 'install' && isArtifactInstall(context));

  return useBuiltSource
    ? provider.getPackageBuiltSourceDirectory(sfpmPackage.name)
    : provider.getPackageDir(sfpmPackage.name);
}

/**
 * Resolve a per-package script's path relative to `baseDir`. npm scripts are
 * exempt — `path` is a `package.json` script name, not a file path.
 */
function resolvePackageScriptPath(script: ScriptDefinition, baseDir: string | undefined): ScriptDefinition {
  if (!baseDir || script.type === 'npm' || path.isAbsolute(script.path)) return script;
  return {...script, path: path.join(baseDir, script.path)};
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
  scripts: ResolvedScript[],
  timing: 'post' | 'pre',
  context: HookContext,
  failOnError: boolean,
): Promise<void> {
  const {logger, provider, sfpmPackage} = context;
  const packageName = sfpmPackage.name;
  // Build post-hooks run against the staged directory; all other hooks use the project/artifact source.
  const isBuildPost = context.operation === 'build' && timing === 'post';
  const packagePath = (isBuildPost
    ? provider.getPackageBuildDirectory(sfpmPackage.name)
    : provider.getPackageDir(sfpmPackage.name)) ?? '';
  const {projectDir} = context;
  const runner = new ScriptRunner(logger);

  for (const {isPackageOverride, script} of scripts) {
    if (isPackageOverride) {
      if (script.packageName) {
        logger?.warn(`Script [${timing}]: ignoring 'packageName' on a per-package override for '${packageName}' — already scoped to this package.`);
      }
    } else if (script.packageName && script.packageName !== packageName) {
      continue;
    }

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
        stagingDirectory: isBuildPost ? provider.getPackageBuildDirectory(sfpmPackage.name) : undefined,
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
