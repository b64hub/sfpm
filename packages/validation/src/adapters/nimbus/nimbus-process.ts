import type {Logger} from '@b64hub/sfpm-core';

import {spawn} from 'node:child_process';

export interface RunNimbusResult {
  exitCode: number;
  stderr: string;
  stdout: string;
  timedOut: boolean;
}

export async function runNimbus(
  binary: string,
  args: string[],
  cwd: string,
  opts: {logger: Logger; signal?: AbortSignal; timeoutMs?: number},
): Promise<RunNimbusResult> {
  opts.logger.debug(`nimbus: spawning ${binary} ${args.join(' ')} (cwd: ${cwd})`);

  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, {
      cwd,
      env: {...process.env, NIMBUS_ACQUISITION: 'sfpm_validation'},
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let timedOut = false;

    const timer = opts.timeoutMs
      ? setTimeout(() => {
        timedOut = true;
        child.kill('SIGTERM');
      }, opts.timeoutMs)
      : undefined;

    const onAbort = () => child.kill('SIGTERM');
    opts.signal?.addEventListener('abort', onAbort);

    child.stdout.on('data', (d: Buffer) => {
      stdout += d;
    });
    child.stderr.on('data', (d: Buffer) => {
      stderr += d;
    });
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (timer) clearTimeout(timer);
      opts.signal?.removeEventListener('abort', onAbort);
      if (signal && !timedOut && !opts.signal?.aborted) {
        reject(new Error(`Nimbus terminated by signal ${signal}`));
        return;
      }

      resolve({
        exitCode: code ?? 1, stderr, stdout, timedOut,
      });
    });
  });
}
