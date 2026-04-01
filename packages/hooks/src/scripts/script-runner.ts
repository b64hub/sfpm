import type {Logger} from '@b64/sfpm-core';

import {spawn} from 'node:child_process';
import {existsSync} from 'node:fs';
import {resolve} from 'node:path';
import {platform} from 'node:process';

import type {ScriptDefinition, ScriptType} from './types.js';

const DEFAULT_TIMEOUT = 300_000; // 5 minutes

/**
 * Environment variables injected into every script execution.
 * Derived from the hook context and merged with any per-script overrides.
 */
export interface ScriptEnvironment {
  /** Custom per-script variables from {@link ScriptDefinition.env}. */
  custom?: Record<string, string>;
  /** The package name being installed. */
  packageName?: string;
  /** The project root directory. */
  projectDir?: string;
  /** The staging directory for the deployment. */
  stagingDirectory?: string;
  /** The target org alias or username. */
  targetOrg?: string;
}

export interface ScriptResult {
  /** Combined stderr output. */
  stderr: string;
  /** Combined stdout output. */
  stdout: string;
  /** Whether the script completed successfully (exit code 0). */
  success: boolean;
}

/**
 * Executes user-defined scripts by shelling out to the appropriate runtime.
 *
 * Supported runtimes:
 * - **shell** — platform shell (`sh -e` on Unix, `cmd.exe /c` on Windows)
 * - **typescript** — `npx tsx`
 * - **javascript** — `node`
 * - **apex** — `sf apex run --file`
 */
export class ScriptRunner {
  constructor(private readonly logger?: Logger) {}

  /**
   * Run a single script definition.
   *
   * @param script - The script definition to execute.
   * @param type - Resolved script type (extension already inferred by caller).
   * @param env - Contextual environment variables to inject.
   * @param projectDir - The project root to resolve relative paths against.
   * @returns The result of the script execution.
   */
  async run(
    script: ScriptDefinition,
    type: ScriptType,
    env: ScriptEnvironment,
    projectDir: string,
  ): Promise<ScriptResult> {
    const scriptPath = resolve(projectDir, script.path);

    if (!existsSync(scriptPath)) {
      throw new Error(`Script not found: ${scriptPath}`);
    }

    const timeout = script.timeout ?? DEFAULT_TIMEOUT;
    const mergedEnv = this.buildEnv(env);

    const {args, command} = this.buildCommand(type, scriptPath, env);

    this.logger?.debug(`Script: executing '${command} ${args.join(' ')}' (timeout: ${timeout}ms)`);

    return this.spawn(command, args, {
      cwd: projectDir,
      env: mergedEnv,
      timeout,
    });
  }

  /**
   * Determine the command and arguments for the given script type.
   */
  private buildCommand(
    type: ScriptType,
    scriptPath: string,
    env: ScriptEnvironment,
  ): {args: string[]; command: string} {
    switch (type) {
    case 'apex': {
      const args = ['apex', 'run', '--file', scriptPath];
      if (env.targetOrg) {
        args.push('--target-org', env.targetOrg);
      }

      return {args, command: 'sf'};
    }

    case 'javascript': {
      return {args: [scriptPath], command: 'node'};
    }

    case 'shell': {
      if (platform === 'win32') {
        return {args: ['/c', scriptPath], command: 'cmd.exe'};
      }

      return {args: ['-e', scriptPath], command: 'sh'};
    }

    case 'typescript': {
      return {args: ['tsx', scriptPath], command: 'npx'};
    }
    }
  }

  /**
   * Merge process.env with context-derived and per-script custom variables.
   */
  private buildEnv(env: ScriptEnvironment): Record<string, string> {
    const merged: Record<string, string> = {};

    // Inherit current process env
    for (const [key, value] of Object.entries(process.env)) {
      if (value !== undefined) {
        merged[key] = value;
      }
    }

    // Context-derived variables
    if (env.targetOrg) merged.SFPM_TARGET_ORG = env.targetOrg;
    if (env.packageName) merged.SFPM_PACKAGE_NAME = env.packageName;
    if (env.projectDir) merged.SFPM_PROJECT_DIR = env.projectDir;
    if (env.stagingDirectory) merged.SFPM_STAGING_DIR = env.stagingDirectory;

    // Per-script custom overrides (highest priority)
    if (env.custom) {
      for (const [key, value] of Object.entries(env.custom)) {
        merged[key] = value;
      }
    }

    return merged;
  }

  /**
   * Spawn a child process and collect output.
   */
  private spawn(
    command: string,
    args: string[],
    options: {cwd: string; env: Record<string, string>; timeout: number},
  ): Promise<ScriptResult> {
    return new Promise(resolve => {
      const child = spawn(command, args, {
        cwd: options.cwd,
        env: options.env,
        stdio: ['pipe', 'pipe', 'pipe'],
        timeout: options.timeout,
      });

      let stdout = '';
      let stderr = '';

      child.stdout.on('data', (data: Buffer) => {
        const chunk = data.toString();
        stdout += chunk;
        this.logger?.debug(`Script [stdout]: ${chunk.trimEnd()}`);
      });

      child.stderr.on('data', (data: Buffer) => {
        const chunk = data.toString();
        stderr += chunk;
        this.logger?.debug(`Script [stderr]: ${chunk.trimEnd()}`);
      });

      child.on('close', code => {
        resolve({stderr, stdout, success: code === 0});
      });

      child.on('error', error => {
        resolve({
          stderr: error.message,
          stdout,
          success: false,
        });
      });
    });
  }
}
