import {
  beforeEach, describe, expect, it, vi,
} from 'vitest';

vi.mock('@actions/core', () => ({
  debug: vi.fn(),
  endGroup: vi.fn(),
  error: vi.fn(),
  getInput: vi.fn(),
  info: vi.fn(),
  notice: vi.fn(),
  setFailed: vi.fn(),
  setOutput: vi.fn(),
  setSecret: vi.fn(),
  startGroup: vi.fn(),
  warning: vi.fn(),
}));

vi.mock('@b64hub/sfpm-core', async importOriginal => {
  const actual = await importOriginal<typeof import('@b64hub/sfpm-core')>();
  return {
    ...actual,
    BuildOrchestrator: {create: vi.fn()},
    LifecycleEngine: {stage: vi.fn()},
    ProjectService: {getInstance: vi.fn()},
  };
});
vi.mock('@b64hub/sfpm-telemetry');
vi.mock('@salesforce/core', () => ({
  Org: {create: vi.fn()},
}));
vi.mock('../src/progress-renderer.js', () => ({
  ActionsProgressRenderer: class {
    attachToBuildOrchestrator = vi.fn();
    printSummary = vi.fn();
  },
}));

import {BuildOrchestrator, LifecycleEngine, ProjectService} from '@b64hub/sfpm-core';
import {createTracer} from '@b64hub/sfpm-telemetry';
import {Org} from '@salesforce/core';

import {build} from '../src/build.js';

describe('build', () => {
  const devhubOrg = {username: 'devhub@test.com'};

  beforeEach(() => {
    vi.clearAllMocks();

    vi.mocked(createTracer).mockReturnValue({
      shutdown: vi.fn().mockResolvedValue(),
      subscribe: vi.fn(),
    } as unknown as ReturnType<typeof createTracer>);

    vi.mocked(ProjectService.getInstance).mockResolvedValue({
      getDefinitionProvider: () => ({
        getAllPackageNames: () => ['pkg-a'],
        getPackageDefinition: () => ({type: 'Unlocked'}),
      }),
      getProjectGraph: () => ({}),
      getSfpmConfig: () => ({hooks: []}),
    } as unknown as Awaited<ReturnType<typeof ProjectService.getInstance>>);

    vi.mocked(LifecycleEngine.stage).mockReturnValue({use: vi.fn()} as unknown as ReturnType<
      typeof LifecycleEngine.stage
    >);

    vi.mocked(BuildOrchestrator.create).mockReturnValue({
      buildAll: vi.fn().mockResolvedValue({failedPackages: [], results: [], success: true}),
      buildBus: new EventTarget(),
      orchestrationBus: new EventTarget(),
    } as unknown as ReturnType<typeof BuildOrchestrator.create>);

    vi.mocked(Org.create).mockResolvedValue(devhubOrg as unknown as Org);
  });

  it('passes the DevHub org to BuildOrchestrator when devhubUsername is set (#93)', async () => {
    await build({devhubUsername: 'devhub@test.com', projectDir: '/p', validation: 'org' as never});

    expect(Org.create).toHaveBeenCalledWith({aliasOrUsername: 'devhub@test.com'});
    expect(vi.mocked(BuildOrchestrator.create).mock.calls[0][1]).toEqual({devhub: devhubOrg});
    expect(vi.mocked(BuildOrchestrator.create).mock.calls[0][3]).toEqual(expect.objectContaining({validation: 'org'}));
  });

  it('does not resolve an org when no devhubUsername is given', async () => {
    await build({projectDir: '/p'});

    expect(Org.create).not.toHaveBeenCalled();
    expect(vi.mocked(BuildOrchestrator.create).mock.calls[0][1]).toEqual({devhub: undefined});
  });
});
