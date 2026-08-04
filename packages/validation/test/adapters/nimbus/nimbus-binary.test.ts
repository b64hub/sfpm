import { homedir, platform } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('node:fs/promises', () => ({
  access: vi.fn(),
}));

import * as fsp from 'node:fs/promises';
import { resolveNimbusBinary } from '../../../src/adapters/nimbus/nimbus-binary.js';
import type { NimbusAdapterDeps } from '../../../src/adapters/nimbus/config.js';

// Same computation as the implementation
const SF_PLUGIN_PATH = join(
  homedir(),
  '.local', 'share', 'sf', 'nimbus', 'bin',
  platform() === 'win32' ? 'nimbus.exe' : 'nimbus',
);

function makeDeps(overrides: Partial<NimbusAdapterDeps['config']> = {}): NimbusAdapterDeps {
  return {
    logger: {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      trace: vi.fn(),
      child: vi.fn().mockReturnThis() as unknown as NimbusAdapterDeps['logger']['child'],
    },
    eventBus: { emit: vi.fn().mockReturnValue(true) },
    config: {
      supportedVersionRange: '^1.2.0',
      daemon: { enabled: false, autoStart: false, autoStop: true },
      ...overrides,
    },
  };
}

const ENOENT = Object.assign(new Error('ENOENT'), { code: 'ENOENT' });

let savedPath: string | undefined;
beforeEach(() => {
  savedPath = process.env['PATH'];
  vi.clearAllMocks();
  vi.mocked(fsp.access).mockRejectedValue(ENOENT); // default: nothing executable
});
afterEach(() => {
  process.env['PATH'] = savedPath;
});

describe('resolveNimbusBinary', () => {
  it('prefers binaryPathOverride over PATH and sf plugin path', async () => {
    const override = '/custom/nimbus';
    vi.mocked(fsp.access).mockImplementation(async (p) => {
      if (p === override) return;
      throw ENOENT;
    });
    process.env['PATH'] = '/usr/bin';

    const result = await resolveNimbusBinary(makeDeps({ binaryPathOverride: override }));
    expect(result).toBe(override);
  });

  it('override not executable → falls through to PATH, no throw', async () => {
    // access always rejects — override not executable, PATH also empty
    process.env['PATH'] = '';

    const result = await resolveNimbusBinary(makeDeps({ binaryPathOverride: '/bad/nimbus' }));
    // Does not throw; returns undefined
    expect(result).toBeUndefined();
  });

  it('prefers PATH over sf plugin path', async () => {
    const pathBin = '/usr/bin/nimbus';
    vi.mocked(fsp.access).mockImplementation(async (p) => {
      if (p === pathBin || p === SF_PLUGIN_PATH) return;
      throw ENOENT;
    });
    process.env['PATH'] = '/usr/bin';

    const result = await resolveNimbusBinary(makeDeps());
    expect(result).toBe(pathBin);
  });

  it('falls back to sf plugin path when not found elsewhere', async () => {
    vi.mocked(fsp.access).mockImplementation(async (p) => {
      if (p === SF_PLUGIN_PATH) return;
      throw ENOENT;
    });
    process.env['PATH'] = '/empty-dir';

    const result = await resolveNimbusBinary(makeDeps());
    expect(result).toBe(SF_PLUGIN_PATH);
  });

  it('returns undefined when nothing found', async () => {
    process.env['PATH'] = '';
    const result = await resolveNimbusBinary(makeDeps());
    expect(result).toBeUndefined();
  });

  it('emits nimbus:binary-resolving on every call', async () => {
    process.env['PATH'] = '';
    const deps = makeDeps();
    await resolveNimbusBinary(deps);
    expect(deps.eventBus.emit).toHaveBeenCalledWith('nimbus:binary-resolving', {});
  });
});
