import type {Logger} from '@b64hub/sfpm-core';

import {existsSync} from 'node:fs';
import {resolve} from 'node:path';

import type {
  ScriptDefinition, ScriptExecutionContext, ScriptExecutor, ScriptResult,
} from '../types.js';

import {buildScriptEnv, DEFAULT_TIMEOUT, spawnScript} from '../script-process.js';

/**
 * Executes TypeScript scripts via `npx tsx`.
 */
export class TypeScriptScriptExecutor implements ScriptExecutor {
  async execute(
    script: ScriptDefinition,
    context: ScriptExecutionContext,
    logger?: Logger,
  ): Promise<ScriptResult> {
    const scriptPath = resolve(context.projectDir, script.path);

    if (!existsSync(scriptPath)) {
      throw new Error(`Script not found: ${scriptPath}`);
    }

    const timeout = script.timeout ?? DEFAULT_TIMEOUT;

    logger?.debug(`Script: executing 'npx tsx ${scriptPath}' (timeout: ${timeout}ms)`);

    return spawnScript('npx', ['tsx', scriptPath], {
      cwd: context.projectDir,
      env: buildScriptEnv(context),
      timeout,
    }, logger);
  }
}
