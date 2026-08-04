import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../src/adapters/nimbus/nimbus-binary.js', () => ({
  resolveNimbusBinary: vi.fn(),
}));
vi.mock('../../../src/adapters/nimbus/nimbus-daemon.js', () => ({
  daemonStatus: vi.fn(),
  startDaemon: vi.fn(),
  stopDaemon: vi.fn(),
}));

import { resolveNimbusBinary } from '../../../src/adapters/nimbus/nimbus-binary.js';
import { daemonStatus, startDaemon, stopDaemon } from '../../../src/adapters/nimbus/nimbus-daemon.js';
import { withNimbusDaemon } from '../../../src/adapters/nimbus/nimbus-session.js';
import type { NimbusAdapterDeps } from '../../../src/adapters/nimbus/config.js';

function makeDeps(daemon: Partial<NimbusAdapterDeps['config']['daemon']> = {}): NimbusAdapterDeps {
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
      daemon: { enabled: true, autoStart: true, autoStop: true, ...daemon },
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(resolveNimbusBinary).mockResolvedValue('/usr/bin/nimbus');
  vi.mocked(daemonStatus).mockResolvedValue({ running: false });
  vi.mocked(startDaemon).mockResolvedValue(true);
  vi.mocked(stopDaemon).mockResolvedValue(undefined);
});

describe('withNimbusDaemon', () => {
  it('daemon.enabled false → fn() called directly, no resolveNimbusBinary/daemonStatus', async () => {
    const deps = makeDeps({ enabled: false });
    const fn = vi.fn().mockResolvedValue('result');

    const result = await withNimbusDaemon(deps, '/project', fn);

    expect(result).toBe('result');
    expect(resolveNimbusBinary).not.toHaveBeenCalled();
    expect(daemonStatus).not.toHaveBeenCalled();
    expect(startDaemon).not.toHaveBeenCalled();
  });

  it('binary not found → fn() runs without daemon, no error', async () => {
    vi.mocked(resolveNimbusBinary).mockResolvedValue(undefined);
    const deps = makeDeps({ enabled: true, autoStart: true });
    const fn = vi.fn().mockResolvedValue('done');

    const result = await withNimbusDaemon(deps, '/project', fn);

    expect(result).toBe('done');
    expect(daemonStatus).not.toHaveBeenCalled();
  });

  it('daemon already running → fn() runs, startDaemon and stopDaemon never called', async () => {
    vi.mocked(daemonStatus).mockResolvedValue({ running: true });
    const deps = makeDeps();
    const fn = vi.fn().mockResolvedValue('done');

    await withNimbusDaemon(deps, '/project', fn);

    expect(startDaemon).not.toHaveBeenCalled();
    expect(stopDaemon).not.toHaveBeenCalled();
    expect(fn).toHaveBeenCalledOnce();
  });

  it('not running, autoStart+autoStop → startDaemon and stopDaemon each called once', async () => {
    const deps = makeDeps({ autoStart: true, autoStop: true });
    const fn = vi.fn().mockResolvedValue('done');

    await withNimbusDaemon(deps, '/project', fn);

    expect(startDaemon).toHaveBeenCalledOnce();
    expect(stopDaemon).toHaveBeenCalledOnce();
  });

  it('startDaemon returns false (no Pro license) → fn() still runs, stopDaemon not called', async () => {
    vi.mocked(startDaemon).mockResolvedValue(false);
    const deps = makeDeps();
    const fn = vi.fn().mockResolvedValue('done');

    const result = await withNimbusDaemon(deps, '/project', fn);

    expect(result).toBe('done');
    expect(fn).toHaveBeenCalledOnce();
    expect(stopDaemon).not.toHaveBeenCalled();
  });

  it('fn() throws → stopDaemon still called (finally block)', async () => {
    const deps = makeDeps({ autoStart: true, autoStop: true });
    const fn = vi.fn().mockRejectedValue(new Error('fn failed'));

    await expect(withNimbusDaemon(deps, '/project', fn)).rejects.toThrow('fn failed');
    expect(stopDaemon).toHaveBeenCalledOnce();
  });
});
