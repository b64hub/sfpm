import type {Logger} from '@b64hub/sfpm-core';

import {spawn} from 'node:child_process';

import type {ScriptResult} from './types.js';

export const DEFAULT_TIMEOUT = 300_000; // 5 minutes

/**
 * Merge process.env with context-derived and per-script custom variables.
 */
export function buildScriptEnv(env: {
  custom?: Record<string, string>;
  packageName?: string;
  projectDir?: string;
  stagingDirectory?: string;
  targetOrg?: string;
}): Record<string, string> {
  const merged: Record<string, string> = {};

  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) {
      merged[key] = value;
    }
  }

  if (env.targetOrg) merged.SFPM_TARGET_ORG = env.targetOrg;
  if (env.packageName) merged.SFPM_PACKAGE_NAME = env.packageName;
  if (env.projectDir) merged.SFPM_PROJECT_DIR = env.projectDir;
  if (env.stagingDirectory) merged.SFPM_STAGING_DIR = env.stagingDirectory;

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
export function spawnScript(
  command: string,
  args: string[],
  options: {cwd: string; env: Record<string, string>; timeout: number},
  logger?: Logger,
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
      logger?.debug(`Script [stdout]: ${chunk.trimEnd()}`);
    });

    child.stderr.on('data', (data: Buffer) => {
      const chunk = data.toString();
      stderr += chunk;
      logger?.debug(`Script [stderr]: ${chunk.trimEnd()}`);
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
