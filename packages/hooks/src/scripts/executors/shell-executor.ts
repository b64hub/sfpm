import type {Logger} from '@b64hub/sfpm-core';

import {existsSync} from 'node:fs';
import {resolve} from 'node:path';

import type {
  ScriptDefinition, ScriptExecutionContext, ScriptExecutor, ScriptResult,
} from '../types.js';

import {buildScriptEnv, DEFAULT_TIMEOUT, spawnScript} from '../script-process.js';

/**
 * Executes shell scripts via the platform shell.
 *
 * - Unix: `sh -e <script>`
 * - Windows: `cmd.exe /c <script>`
 */
export class ShellScriptExecutor implements ScriptExecutor {
  async execute(
    script: ScriptDefinition,
    context: ScriptExecutionContext,
    logger?: Logger,
  ): Promise<ScriptResult> {
    const scriptPath = resolve(context.projectDir, script.path);

    if (!existsSync(scriptPath)) {
      throw new Error(`Script not found: ${scriptPath}`);
    }

    const isWindows = process.platform === 'win32';
    const command = isWindows ? 'cmd.exe' : 'sh';
    const args = isWindows ? ['/c', scriptPath] : ['-e', scriptPath];
    const timeout = script.timeout ?? DEFAULT_TIMEOUT;

    logger?.debug(`Script: executing '${command} ${args.join(' ')}' (timeout: ${timeout}ms)`);

    return spawnScript(command, args, {
      cwd: context.projectDir,
      env: buildScriptEnv(context),
      timeout,
    }, logger);
  }
}
