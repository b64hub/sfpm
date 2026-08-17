import type {Logger} from '@b64hub/sfpm-core';

import {
  beforeEach, describe, expect, it, vi,
} from 'vitest';

import type {PoolOrg} from '../../../src/org/pool-org.js';

import {DeploymentTask} from '../../../src/pool/tasks/deployment-task.js';

// ============================================================================
// Mocks
// ============================================================================

vi.mock('@salesforce/core', () => ({
  Org: {
    create: vi.fn().mockResolvedValue({username: 'test@scratch.org'}),
  },
}));

const {
  ArtifactProviderMock, forArtifact, forSource, projectServiceCreate, WorkspaceProviderMock,
} = vi.hoisted(() => {
  const mockProjectService = {
    getDefinitionProvider: vi.fn().mockReturnValue({getAllPackageNames: () => ['pkg-a']}),
    getProjectGraph: vi.fn().mockReturnValue({}),
  };
  const mockOrchestrator = {
    installAll: vi.fn().mockResolvedValue({failedPackages: [], success: true}),
    installBus: {on: vi.fn()},
    orchestrationBus: {on: vi.fn()},
  };

  return {
    ArtifactProviderMock: vi.fn().mockImplementation(function (this: {options: unknown; type: string}, options: unknown) {
      this.options = options;
      this.type = 'artifact';
    }),
    forArtifact: vi.fn().mockReturnValue(mockOrchestrator),
    forSource: vi.fn().mockReturnValue(mockOrchestrator),
    projectServiceCreate: vi.fn().mockResolvedValue(mockProjectService),
    WorkspaceProviderMock: vi.fn().mockImplementation(function (this: {options: unknown; type: string}, options: unknown) {
      this.options = options;
      this.type = 'workspace';
    }),
  };
});

vi.mock('@b64hub/sfpm-core', () => ({
  ArtifactProvider: ArtifactProviderMock,
  InstallOrchestrator: {forArtifact, forSource},
  ProjectService: {create: projectServiceCreate},
  WorkspaceProvider: WorkspaceProviderMock,
}));

// ============================================================================
// Helpers
// ============================================================================

function createMockOrg(): PoolOrg {
  return {
    auth: {username: 'test@scratch.org'},
    orgId: '00D000000000001',
    orgType: 'scratch' as const,
  };
}

function createMockLogger(): Logger {
  return {
    debug: vi.fn(), error: vi.fn(), info: vi.fn(), trace: vi.fn(), warn: vi.fn(),
  };
}

// ============================================================================
// Tests
// ============================================================================

describe('DeploymentTask', () => {
  let logger: Logger;

  beforeEach(() => {
    vi.clearAllMocks();
    logger = createMockLogger();
  });

  it('defaults to ArtifactProvider + forArtifact (downloaded artifacts)', async () => {
    const task = new DeploymentTask({continueOnError: false, workingDirectory: '/proj'});

    await task.execute(createMockOrg(), logger);

    expect(ArtifactProviderMock).toHaveBeenCalledWith({projectDir: '/proj'});
    expect(WorkspaceProviderMock).not.toHaveBeenCalled();
    expect(forArtifact).toHaveBeenCalled();
    expect(forSource).not.toHaveBeenCalled();
    expect(projectServiceCreate).toHaveBeenCalledWith('/proj', expect.objectContaining({type: 'artifact'}));
  });

  it('uses a dist-aware WorkspaceProvider + forSource when useLocalSource is true', async () => {
    const task = new DeploymentTask({continueOnError: false, useLocalSource: true, workingDirectory: '/proj'});

    await task.execute(createMockOrg(), logger);

    expect(WorkspaceProviderMock).toHaveBeenCalledWith({distAware: true, projectDir: '/proj'});
    expect(ArtifactProviderMock).not.toHaveBeenCalled();
    expect(forSource).toHaveBeenCalled();
    expect(forArtifact).not.toHaveBeenCalled();
  });

  it('resolves the project service once per task instance across multiple org executions', async () => {
    const task = new DeploymentTask({continueOnError: false, workingDirectory: '/proj'});

    await task.execute(createMockOrg(), logger);
    await task.execute(createMockOrg(), logger);

    expect(projectServiceCreate).toHaveBeenCalledTimes(1);
  });
});
