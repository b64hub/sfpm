import {constants} from 'node:fs';
import {access} from 'node:fs/promises';
import {homedir, platform} from 'node:os';
import {join} from 'node:path';

import type {NimbusAdapterDeps} from './config.js';

export const INSTALL_HINT = 'Install nimbus: curl -fsSL https://install.testnimbus.dev | sh';

function binaryName(): string {
  return platform() === 'win32' ? 'nimbus.exe' : 'nimbus';
}

async function isExecutable(filePath: string): Promise<boolean> {
  try {
    await access(filePath, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

async function findOnPath(): Promise<string | undefined> {
  const name = binaryName();
  const sep = platform() === 'win32' ? ';' : ':';
  const candidates = (process.env.PATH ?? '').split(sep).filter(Boolean).map(dir => join(dir, name));
  const accessible = await Promise.all(candidates.map(c => isExecutable(c)));
  return candidates.find((_, i) => accessible[i]);
}

export async function resolveNimbusBinary(deps: NimbusAdapterDeps): Promise<string | undefined> {
  deps.eventBus.emit('nimbus:binary-resolving', {});
  const {config, logger} = deps;

  if (config.binaryPathOverride) {
    logger.debug(`nimbus: checking override: ${config.binaryPathOverride}`);
    if (await isExecutable(config.binaryPathOverride)) {
      logger.debug(`nimbus: using override: ${config.binaryPathOverride}`);
      return config.binaryPathOverride;
    }

    logger.debug(`nimbus: override not executable (${config.binaryPathOverride}), continuing`);
  }

  const pathBinary = await findOnPath();
  if (pathBinary) {
    logger.debug(`nimbus: found on PATH: ${pathBinary}`);
    return pathBinary;
  }

  logger.debug('nimbus: not found on PATH');

  // Last resort: check the sf CLI plugin's managed install location (read-only reuse, no SFPM ownership).
  // Falls through silently to undefined if the sf plugin relocates its install directory.
  const sfPluginPath = join(homedir(), '.local', 'share', 'sf', 'nimbus', 'bin', binaryName());
  if (await isExecutable(sfPluginPath)) {
    logger.debug(`nimbus: found in sf plugin directory: ${sfPluginPath}`);
    return sfPluginPath;
  }

  logger.debug(`nimbus: not found in sf plugin directory: ${sfPluginPath}`);

  return undefined;
}
