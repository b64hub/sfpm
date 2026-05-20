import type {Logger} from '@b64hub/sfpm-core';

import {readFileSync} from 'node:fs';
import {join} from 'node:path';

import type {
  ScriptDefinition, ScriptExecutionContext, ScriptExecutor, ScriptResult,
} from '../types.js';

import {buildScriptEnv, DEFAULT_TIMEOUT, spawnScript} from '../script-process.js';

/**
 * Executes npm scripts via `npm run <script-name>`.
 *
 * Validates the script exists in the package's `package.json` before
 * running. Uses the package directory as CWD (not the project root).
 */
export class NpmScriptExecutor implements ScriptExecutor {
  async execute(
    script: ScriptDefinition,
    context: ScriptExecutionContext,
    logger?: Logger,
  ): Promise<ScriptResult> {
    if (!this.hasNpmScript(context.packagePath, script.path)) {
      throw new ScriptNotFoundError(`npm script '${script.path}' is not defined in ${context.packagePath}/package.json`);
    }

    const timeout = script.timeout ?? DEFAULT_TIMEOUT;

    logger?.debug(`Script: executing 'npm run ${script.path}' (timeout: ${timeout}ms)`);

    return spawnScript('npm', ['run', script.path], {
      cwd: context.packagePath,
      env: buildScriptEnv(context),
      timeout,
    }, logger);
  }

  private hasNpmScript(packagePath: string, scriptName: string): boolean {
    try {
      const pkgJsonPath = join(packagePath, 'package.json');
      const pkgJson = JSON.parse(readFileSync(pkgJsonPath, 'utf8'));
      return Boolean(pkgJson?.scripts?.[scriptName]);
    } catch {
      return false;
    }
  }
}

/**
 * Thrown when an npm script is not found in the package's `package.json`.
 *
 * Used to distinguish "missing script" (skip gracefully) from runtime
 * errors (fail the pipeline).
 */
export class ScriptNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ScriptNotFoundError';
  }
}
