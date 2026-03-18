import {
  afterEach, beforeEach, describe, expect, it, vi,
} from 'vitest';

import {ArtifactService} from '../../src/artifacts/artifact-service.js';

// Mock @salesforce/core
vi.mock('@salesforce/core', () => ({
  Org: {
    create: vi.fn(),
  },
}));

// Mock getPipelineRunId utility
vi.mock('../../src/utils/pipeline.js', () => ({
  getPipelineRunId: vi.fn(),
}));

// Import after mocks are set up
import {getPipelineRunId} from '../../src/utils/pipeline.js';

describe('ArtifactService.createHistoryRecord', () => {
  let service: ArtifactService;
  let mockConnection: any;
  let mockOrg: any;
  let createFn: ReturnType<typeof vi.fn>;

  const mockLogger = {
    debug: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    log: vi.fn(),
    trace: vi.fn(),
    warn: vi.fn(),
  };

  const mockSfpmPackage = {
    commitId: 'abc123',
    name: 'my-package',
    sourceHash: 'sha256-hash',
    tag: 'my-package@1.0.0',
    version: '1.0.0',
  } as any;

  beforeEach(() => {
    vi.clearAllMocks();

    createFn = vi.fn().mockResolvedValue({id: 'a0B000000001', success: true});
    mockConnection = {
      query: vi.fn().mockResolvedValue({records: []}),
      sobject: vi.fn().mockReturnValue({
        create: createFn,
      }),
      tooling: {query: vi.fn()},
    };
    mockOrg = {
      getConnection: vi.fn().mockReturnValue(mockConnection),
      getUsername: vi.fn().mockReturnValue('test@example.com'),
    };

    service = new ArtifactService(mockLogger, mockOrg);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('should create a history record with correct field values', async () => {
    const result = await service.createHistoryRecord(mockSfpmPackage, {
      deployId: '0Af000000001',
    });

    expect(result).toBe('a0B000000001');
    expect(mockConnection.sobject).toHaveBeenCalledWith('Sfpm_Artifact_History__c');
    expect(createFn).toHaveBeenCalledWith({
      Checksum__c: 'sha256-hash',
      Commit_Id__c: 'abc123',
      Deploy_Id__c: '0Af000000001',
      Name: 'my-package',
      Pipeline_Run_Id__c: undefined,
      Tag__c: 'my-package@1.0.0',
      Version__c: '1.0.0',
    });
  });

  it('should include pipeline run ID when available', async () => {
    vi.mocked(getPipelineRunId).mockReturnValue('gh-run-42');

    await service.createHistoryRecord(mockSfpmPackage);

    expect(createFn).toHaveBeenCalledWith(
      expect.objectContaining({
        Pipeline_Run_Id__c: 'gh-run-42',
      }),
    );
  });

  it('should handle missing deployId gracefully', async () => {
    const result = await service.createHistoryRecord(mockSfpmPackage);

    expect(result).toBe('a0B000000001');
    expect(createFn).toHaveBeenCalledWith(
      expect.objectContaining({
        Deploy_Id__c: undefined,
      }),
    );
  });

  it('should handle missing sourceHash and commitId', async () => {
    const minimalPackage = {
      commitId: undefined,
      name: 'bare-pkg',
      sourceHash: undefined,
      tag: 'bare-pkg@0.1.0',
      version: '0.1.0',
    } as any;

    await service.createHistoryRecord(minimalPackage);

    expect(createFn).toHaveBeenCalledWith(
      expect.objectContaining({
        Checksum__c: '',
        Commit_Id__c: '',
        Name: 'bare-pkg',
        Version__c: '0.1.0',
      }),
    );
  });

  it('should degrade gracefully when custom object does not exist', async () => {
    createFn.mockRejectedValue(new Error('sObject type Sfpm_Artifact_History__c is not supported'));

    const result = await service.createHistoryRecord(mockSfpmPackage);

    expect(result).toBeUndefined();
    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.stringContaining('Unable to create artifact history record'),
    );
    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.stringContaining('Sfpm_Artifact_History__c may not be deployed'),
    );
  });

  it('should throw when org is not set', async () => {
    const serviceNoOrg = new ArtifactService(mockLogger);

    await expect(serviceNoOrg.createHistoryRecord(mockSfpmPackage)).rejects.toThrow(
      'Org connection required for createHistoryRecord',
    );
  });

  it('should log info on successful creation', async () => {
    await service.createHistoryRecord(mockSfpmPackage);

    expect(mockLogger.info).toHaveBeenCalledWith(
      expect.stringMatching(/Created artifact history record.*my-package@1\.0\.0.*a0B000000001/),
    );
  });

  it('should handle array result from create', async () => {
    createFn.mockResolvedValue([{id: 'a0B000000002', success: true}]);

    const result = await service.createHistoryRecord(mockSfpmPackage);
    expect(result).toBe('a0B000000002');
  });
});
