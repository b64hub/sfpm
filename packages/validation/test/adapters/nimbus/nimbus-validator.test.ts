import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../src/adapters/nimbus/nimbus-binary.js', () => ({
  INSTALL_HINT: 'Install nimbus: curl -fsSL https://install.testnimbus.dev | sh',
  resolveNimbusBinary: vi.fn(),
}));
vi.mock('../../../src/adapters/nimbus/nimbus-process.js', () => ({
  runNimbus: vi.fn(),
}));

import { resolveNimbusBinary } from '../../../src/adapters/nimbus/nimbus-binary.js';
import { runNimbus } from '../../../src/adapters/nimbus/nimbus-process.js';
import { createNimbusValidator } from '../../../src/adapters/nimbus/nimbus-validator.js';
import type { NimbusAdapterDeps } from '../../../src/adapters/nimbus/config.js';
import type { ValidationContext } from '../../../src/contracts/validation-context.js';

const validatePassedFixture = readFileSync(
  new URL('../../../test/fixtures/nimbus-validate-passed.json', import.meta.url),
  'utf8',
);

function makeDeps(): NimbusAdapterDeps {
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
      pinnedVersion: '1.2.3',
      supportedVersionRange: '^1.2.0',
      autoInstall: false,
      dataDir: '/test-data',
      daemon: { enabled: false, autoStart: false, autoStop: true },
    },
  };
}

const BASE_CTX: ValidationContext = {
  packageId: 'my-pkg',
  packagePath: '/project/my-pkg',
  projectRoot: '/project',
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe('createNimbusValidator', () => {
  it('binary unavailable → status skipped, validator:availability + validator:complete emitted', async () => {
    vi.mocked(resolveNimbusBinary).mockResolvedValue(undefined);
    const deps = makeDeps();
    const validator = createNimbusValidator(deps);

    const result = await validator.run('compile', BASE_CTX);

    expect(result.status).toBe('skipped');
    expect(deps.eventBus.emit).toHaveBeenCalledWith('validator:availability', expect.objectContaining({
      packageId: 'my-pkg',
      availability: expect.objectContaining({ available: false }),
    }));
    expect(deps.eventBus.emit).toHaveBeenCalledWith('validator:complete', expect.objectContaining({
      packageId: 'my-pkg',
      result: expect.objectContaining({ status: 'skipped' }),
    }));
  });

  it('version outside supportedVersionRange → status skipped with reason mentioning range', async () => {
    vi.mocked(resolveNimbusBinary).mockResolvedValue('/usr/bin/nimbus');
    vi.mocked(runNimbus).mockResolvedValue({
      stdout: 'nimbus 0.5.0', stderr: '', exitCode: 0, timedOut: false,
    });
    const deps = makeDeps();
    const validator = createNimbusValidator(deps);

    const result = await validator.run('compile', BASE_CTX);

    expect(result.status).toBe('skipped');
    expect(result.diagnostics[0].message).toContain('^1.2.0');
    expect(deps.eventBus.emit).toHaveBeenCalledWith('validator:complete', expect.objectContaining({
      result: expect.objectContaining({ status: 'skipped' }),
    }));
  });

  it('successful compile run → status passed', async () => {
    vi.mocked(resolveNimbusBinary).mockResolvedValue('/usr/bin/nimbus');
    vi.mocked(runNimbus)
      .mockResolvedValueOnce({ stdout: 'nimbus 1.2.3', stderr: '', exitCode: 0, timedOut: false })
      .mockResolvedValueOnce({ stdout: validatePassedFixture, stderr: '', exitCode: 0, timedOut: false });
    const deps = makeDeps();
    const validator = createNimbusValidator(deps);

    const result = await validator.run('compile', BASE_CTX);

    expect(result.status).toBe('passed');
    expect(result.capability).toBe('compile');
    expect(deps.eventBus.emit).toHaveBeenCalledWith('validator:complete', expect.objectContaining({
      result: expect.objectContaining({ status: 'passed' }),
    }));
  });

  it('timedOut → status error, message mentions timed out', async () => {
    vi.mocked(resolveNimbusBinary).mockResolvedValue('/usr/bin/nimbus');
    vi.mocked(runNimbus)
      .mockResolvedValueOnce({ stdout: '1.2.3', stderr: '', exitCode: 0, timedOut: false })
      .mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 1, timedOut: true });
    const deps = makeDeps();
    const validator = createNimbusValidator(deps);

    const result = await validator.run('compile', { ...BASE_CTX, timeoutMs: 5000 });

    expect(result.status).toBe('error');
    expect(result.diagnostics[0].message).toContain('timed out');
    expect(deps.eventBus.emit).toHaveBeenCalledWith('validator:complete', expect.any(Object));
  });

  it('runNimbus throws → status error, validator:error + validator:complete emitted', async () => {
    vi.mocked(resolveNimbusBinary).mockResolvedValue('/usr/bin/nimbus');
    vi.mocked(runNimbus)
      .mockResolvedValueOnce({ stdout: '1.2.3', stderr: '', exitCode: 0, timedOut: false })
      .mockRejectedValueOnce(new Error('connection refused'));
    const deps = makeDeps();
    const validator = createNimbusValidator(deps);

    const result = await validator.run('compile', BASE_CTX);

    expect(result.status).toBe('error');
    expect(deps.eventBus.emit).toHaveBeenCalledWith('validator:error', expect.objectContaining({
      packageId: 'my-pkg',
      message: 'connection refused',
    }));
    expect(deps.eventBus.emit).toHaveBeenCalledWith('validator:complete', expect.objectContaining({
      result: expect.objectContaining({ status: 'error' }),
    }));
  });

  it('every code path emits exactly one validator:complete', async () => {
    const scenarios: Array<() => void> = [
      // unavailable
      () => vi.mocked(resolveNimbusBinary).mockResolvedValue(null),
      // version mismatch
      () => {
        vi.mocked(resolveNimbusBinary).mockResolvedValue('/bin/nimbus');
        vi.mocked(runNimbus).mockResolvedValue({ stdout: '0.1.0', stderr: '', exitCode: 0, timedOut: false });
      },
      // success
      () => {
        vi.mocked(resolveNimbusBinary).mockResolvedValue('/bin/nimbus');
        vi.mocked(runNimbus)
          .mockResolvedValueOnce({ stdout: '1.2.3', stderr: '', exitCode: 0, timedOut: false })
          .mockResolvedValueOnce({ stdout: validatePassedFixture, stderr: '', exitCode: 0, timedOut: false });
      },
    ];

    for (const setup of scenarios) {
      vi.clearAllMocks();
      setup();
      const deps = makeDeps();
      const validator = createNimbusValidator(deps);
      await validator.run('compile', BASE_CTX);

      const completeCalls = vi.mocked(deps.eventBus.emit).mock.calls.filter(
        ([event]) => event === 'validator:complete',
      );
      expect(completeCalls).toHaveLength(1);
    }
  });
});
