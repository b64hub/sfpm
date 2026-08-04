import type {NimbusAdapterDeps} from './config.js';

import {resolveNimbusBinary} from './nimbus-binary.js';
import {daemonStatus, startDaemon, stopDaemon} from './nimbus-daemon.js';

export async function withNimbusDaemon<T>(
  deps: NimbusAdapterDeps,
  projectRoot: string,
  fn: () => Promise<T>,
): Promise<T> {
  if (!deps.config.daemon.enabled) return fn();

  const binary = await resolveNimbusBinary(deps);
  if (!binary) return fn(); // binary not installed — run without daemon
  const status = await daemonStatus(binary, projectRoot, deps);

  let startedByUs = false;
  if (!status.running) {
    if (!deps.config.daemon.autoStart) return fn();
    startedByUs = await startDaemon(binary, projectRoot, deps);
  }

  try {
    return await fn();
  } finally {
    if (startedByUs && deps.config.daemon.autoStop) {
      await stopDaemon(binary, projectRoot, deps);
    }
  }
}
