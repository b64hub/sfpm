import type {Logger} from '@b64hub/sfpm-core';

import {existsSync} from 'node:fs';
import {resolve} from 'node:path';

import type {
  ScriptDefinition, ScriptExecutionContext, ScriptExecutor, ScriptResult,
} from '../types.js';

import {buildScriptEnv, DEFAULT_TIMEOUT, spawnScript} from '../script-process.js';

/**
 * Executes anonymous Apex scripts via `sf apex run`.
 *
 * Requires a target org — the `--target-org` flag is always included
 * when `context.targetOrg` is set.
 */
export class ApexScriptExecutor implements ScriptExecutor {
  async execute(
    script: ScriptDefinition,
    context: ScriptExecutionContext,
    logger?: Logger,
  ): Promise<ScriptResult> {
    const scriptPath = resolve(context.projectDir, script.path);

    if (!existsSync(scriptPath)) {
      throw new Error(`Script not found: ${scriptPath}`);
    }

    if (!context.targetOrg) {
      throw new Error(`Apex script '${script.path}' requires a target org but none was provided`);
    }

    const args = ['apex', 'run', '--file', scriptPath, '--target-org', context.targetOrg];
    const timeout = script.timeout ?? DEFAULT_TIMEOUT;

    logger?.debug(`Script: executing 'sf ${args.join(' ')}' (timeout: ${timeout}ms)`);

    return spawnScript('sf', args, {
      cwd: context.projectDir,
      env: buildScriptEnv(context),
      timeout,
    }, logger);
  }
}
