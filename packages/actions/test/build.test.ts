import EventEmitter from 'node:events';
import {
  beforeEach, describe, expect, it, vi,
} from 'vitest';

vi.mock('@actions/core', () => ({
  debug: vi.fn(),
  endGroup: vi.fn(),
  error: vi.fn(),
  info: vi.fn(),
  notice: vi.fn(),
  setFailed: vi.fn(),
  setOutput: vi.fn(),
  startGroup: vi.fn(),
  warning: vi.fn(),
}));

vi.mock('@b64hub/sfpm-core', async importOriginal => {
  const actual = await importOriginal<typeof import('@b64hub/sfpm-core')>();
  return {
    ...actual,
    BuildOrchestrator: vi.fn(),
    LifecycleEngine: {
      stage: vi.fn(),
    },
    ProjectService: {
      getInstance: vi.fn(),
    },
  };
});
vi.mock('@b64hub/sfpm-telemetry');
vi.mock('@salesforce/core', () => ({
  Org: {
    create: vi.fn(),
  },
}));

import {BuildOrchestrator, LifecycleEngine, ProjectService} from '@b64hub/sfpm-core';
import {createTracer} from '@b64hub/sfpm-telemetry';
import {Org} from '@salesforce/core';

import {build} from '../src/build.js';

describe('build', () => {
  const devhubOrg = {username: 'devhub@test.com'};
  let orchestratorCreate: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();

    vi.mocked(ProjectService.getInstance).mockResolvedValue({
      getDefinitionProvider: () => ({
        getAllPackageNames: () => ['pkg-a'],
        getPackageDefinition: () => ({type: 'unlocked'}),
      }),
      getProjectGraph: () => ({}),
      getSfpmConfig: () => ({hooks: []}),
    } as any);

    vi.mocked(LifecycleEngine.stage).mockReturnValue({use: vi.fn()} as any);
    vi.mocked(createTracer).mockReturnValue({shutdown: vi.fn(), subscribe: vi.fn()} as any);
    vi.mocked(Org.create).mockResolvedValue(devhubOrg as any);

    orchestratorCreate = vi.fn().mockReturnValue({
      buildAll: vi.fn().mockResolvedValue({
        failedPackages: [],
        results: [{
          packageName: 'pkg-a', result: undefined, skipped: false, success: true,
        }],
        success: true,
      }),
      buildBus: new EventEmitter(),
      orchestrationBus: new EventEmitter(),
    });
    (BuildOrchestrator as any).create = orchestratorCreate;
  });

  // Regression test for #96: devhub-username must reach the orchestrator as buildOrg.devhub
  it('passes the created DevHub org to BuildOrchestrator when devhubUsername is set', async () => {
    await build({devhubUsername: 'devhub@test.com', projectDir: '/p'});

    expect(Org.create).toHaveBeenCalledWith({aliasOrUsername: 'devhub@test.com'});
    expect(orchestratorCreate).toHaveBeenCalledWith(
      expect.anything(),
      {devhub: devhubOrg},
      expect.anything(),
      expect.anything(),
      expect.anything(),
    );
  });

  it('passes an empty buildOrg and skips DevHub resolution when devhubUsername is omitted', async () => {
    await build({projectDir: '/p'});

    expect(Org.create).not.toHaveBeenCalled();
    expect(orchestratorCreate).toHaveBeenCalledWith(
      expect.anything(),
      {},
      expect.anything(),
      expect.anything(),
      expect.anything(),
    );
  });

  it('rejects when the DevHub org cannot be resolved', async () => {
    vi.mocked(Org.create).mockRejectedValue(new Error('No authorization information found'));

    await expect(build({devhubUsername: 'bad', projectDir: '/p'})).rejects.toThrow('No authorization information found');
    expect(orchestratorCreate).not.toHaveBeenCalled();
  });
});
