import type {NimbusAdapterDeps} from './config.js';

import {runNimbus} from './nimbus-process.js';

export interface DaemonStatus {
  licensed?: boolean;
  running: boolean;
}

// ASSUMED SUBCOMMANDS — `daemon stop` is confirmed (used in nimbus-binary.ts
// during Windows binary swap). `daemon start` / `daemon status --json` are
// inferred by symmetry and MUST be confirmed against the real CLI before
// this file ships. See Open Questions in the implementation plan.

export async function daemonStatus(
  binary: string,
  cwd: string,
  deps: NimbusAdapterDeps,
): Promise<DaemonStatus> {
  const {exitCode, stdout} = await runNimbus(binary, ['daemon', 'status', '--json'], cwd, {
    logger: deps.logger,
  });
  if (exitCode !== 0) return {running: false};
  try {
    const parsed = JSON.parse(stdout) as {licensed?: boolean; running?: boolean;};
    return {licensed: parsed.licensed, running: Boolean(parsed.running)};
  } catch {
    return {running: false};
  }
}

export async function startDaemon(
  binary: string,
  cwd: string,
  deps: NimbusAdapterDeps,
): Promise<boolean> {
  deps.eventBus.emit('nimbus:daemon-starting', {});
  const args: string[] = [
    'daemon',
    'start',
    ...(deps.config.daemon.idleTimeoutMs
      ? ['--idle-timeout', String(deps.config.daemon.idleTimeoutMs)]
      : []),
  ];
  const {exitCode, stderr} = await runNimbus(binary, args, cwd, {logger: deps.logger});

  if (exitCode !== 0) {
    deps.logger.info(`nimbus: daemon unavailable (${stderr.trim()}), continuing without it`);
    deps.eventBus.emit('nimbus:daemon-unavailable', {reason: stderr.trim()});
    return false;
  }

  deps.eventBus.emit('nimbus:daemon-started', {});
  return true;
}

export async function stopDaemon(
  binary: string,
  cwd: string,
  deps: NimbusAdapterDeps,
): Promise<void> {
  await runNimbus(binary, ['daemon', 'stop'], cwd, {logger: deps.logger}).catch(() => {});
  deps.eventBus.emit('nimbus:daemon-stopped', {});
}
