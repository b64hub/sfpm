import type {Logger} from '@b64hub/sfpm-core';

import type {
  ScriptDefinition, ScriptExecutionContext, ScriptExecutor, ScriptResult, ScriptType,
} from './types.js';

import {ApexScriptExecutor} from './executors/apex-executor.js';
import {JavaScriptScriptExecutor} from './executors/javascript-executor.js';
import {NpmScriptExecutor} from './executors/npm-executor.js';
import {ShellScriptExecutor} from './executors/shell-executor.js';
import {TypeScriptScriptExecutor} from './executors/typescript-executor.js';

/**
 * Resolves the appropriate {@link ScriptExecutor} for a given script type
 * and delegates execution.
 *
 * Supported runtimes:
 * - **shell** — platform shell (`sh -e` on Unix, `cmd.exe /c` on Windows)
 * - **typescript** — `npx tsx`
 * - **javascript** — `node`
 * - **apex** — `sf apex run --file` (requires a target org)
 * - **npm** — `npm run <script-name>`
 */
export class ScriptRunner {
  private readonly executors: Record<ScriptType, ScriptExecutor> = {
    apex: new ApexScriptExecutor(),
    javascript: new JavaScriptScriptExecutor(),
    npm: new NpmScriptExecutor(),
    shell: new ShellScriptExecutor(),
    typescript: new TypeScriptScriptExecutor(),
  };

  constructor(private readonly logger?: Logger) {}

  /**
   * Run a single script by delegating to the executor for the given type.
   */
  async run(
    script: ScriptDefinition,
    type: ScriptType,
    context: ScriptExecutionContext,
  ): Promise<ScriptResult> {
    const executor = this.executors[type];
    return executor.execute(script, context, this.logger);
  }
}

