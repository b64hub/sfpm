import {
  beforeEach, describe, expect, it, vi,
} from 'vitest';

import type {Logger} from '@b64/sfpm-core';
import type {Org} from '@salesforce/core';

import type {PoolOrg} from '../../../src/org/pool-org.js';

import {ArtifactPackageInstallTask} from '../../../src/pool/tasks/artifact-package-install-task.js';

// ============================================================================
// Mocks
// ============================================================================

// Mock @salesforce/core — Org.create returns a mock org with a tooling connection
const mockToolingCreate = vi.fn();
const mockToolingRetrieve = vi.fn();
const mockToolingQuery = vi.fn();
const mockScratchOrgConnection = {
  tooling: {
    create: mockToolingCreate,
    query: mockToolingQuery,
    retrieve: mockToolingRetrieve,
  },
};
const mockScratchOrg = {
  getConnection: vi.fn().mockReturnValue(mockScratchOrgConnection),
};

vi.mock('@salesforce/core', () => ({
  Org: {
    create: vi.fn().mockImplementation(() => mockScratchOrg),
  },
}));

// Mock @b64/sfpm-core — PackageService
const mockListAllPackages = vi.fn();
const mockGetPackage2VersionById = vi.fn();
const mockIsSubscriberVersionInstalled = vi.fn();

vi.mock('@b64/sfpm-core', async () => {
  return {
    PackageService: vi.fn(function (this: Record<string, unknown>) {
      this.getPackage2VersionById = mockGetPackage2VersionById;
      this.isSubscriberVersionInstalled = mockIsSubscriberVersionInstalled;
      this.listAllPackages = mockListAllPackages;
    }),
  };
});

// ============================================================================
// Helpers
// ============================================================================

function createMockDevhub(): Org {
  return {
    getConnection: vi.fn(),
    getUsername: vi.fn().mockReturnValue('devhub@test.com'),
    isDevHubOrg: vi.fn().mockReturnValue(true),
  } as unknown as Org;
}

function createMockOrg(username = 'test@scratch.org'): PoolOrg {
  return {
    auth: {username},
    orgId: '00D000000000001',
    orgType: 'scratch' as const,
  };
}

function createMockLogger(): Logger {
  return {
    debug: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    log: vi.fn(),
    trace: vi.fn(),
    warn: vi.fn(),
  };
}

// ============================================================================
// Tests
// ============================================================================

describe('ArtifactPackageInstallTask', () => {
  let devhub: Org;
  let logger: Logger;

  beforeEach(() => {
    vi.clearAllMocks();
    devhub = createMockDevhub();
    logger = createMockLogger();

    // Default: package exists on devhub with a released version
    mockListAllPackages.mockResolvedValue([
      {Id: '0Ho000000000001', Name: 'sfpm-artifact'},
    ]);
    mockGetPackage2VersionById.mockResolvedValue([
      {SubscriberPackageVersionId: '04t000000000001'},
    ]);
    mockIsSubscriberVersionInstalled.mockResolvedValue(false);
  });

  it('should have the correct task name', () => {
    const task = new ArtifactPackageInstallTask({devhub});
    expect(task.name).toBe('install-artifact-package');
  });

  it('should default continueOnError to false', () => {
    const task = new ArtifactPackageInstallTask({devhub});
    expect(task.continueOnError).toBe(false);
  });

  it('should respect continueOnError option', () => {
    const task = new ArtifactPackageInstallTask({continueOnError: true, devhub});
    expect(task.continueOnError).toBe(true);
  });

  it('should fail when org has no username', async () => {
    const task = new ArtifactPackageInstallTask({devhub});
    const org = createMockOrg(undefined as unknown as string);
    org.auth.username = undefined as unknown as string;

    const result = await task.execute(org, logger);

    expect(result.success).toBe(false);
    expect(result.error).toContain('no username');
  });

  it('should fail when package is not found on devhub', async () => {
    mockListAllPackages.mockResolvedValue([]);

    const task = new ArtifactPackageInstallTask({devhub});
    const result = await task.execute(createMockOrg(), logger);

    expect(result.success).toBe(false);
    expect(result.error).toContain('not found on the DevHub');
  });

  it('should fail when no released versions exist', async () => {
    mockGetPackage2VersionById.mockResolvedValue([]);

    const task = new ArtifactPackageInstallTask({devhub});
    const result = await task.execute(createMockOrg(), logger);

    expect(result.success).toBe(false);
    expect(result.error).toContain('not found on the DevHub');
  });

  it('should skip installation when already installed', async () => {
    mockIsSubscriberVersionInstalled.mockResolvedValue(true);

    const task = new ArtifactPackageInstallTask({devhub});
    const result = await task.execute(createMockOrg(), logger);

    expect(result.success).toBe(true);
    expect(mockToolingCreate).not.toHaveBeenCalled();
    expect(logger.info).toHaveBeenCalledWith(
      expect.stringContaining('already installed'),
    );
  });

  it('should install the package when not already installed', async () => {
    mockToolingCreate.mockResolvedValue({id: 'req-001', success: true});
    mockToolingRetrieve.mockResolvedValue({Status: 'SUCCESS'});

    const task = new ArtifactPackageInstallTask({devhub});
    const result = await task.execute(createMockOrg(), logger);

    expect(result.success).toBe(true);
    expect(mockToolingCreate).toHaveBeenCalledWith('PackageInstallRequest', expect.objectContaining({
      SubscriberPackageVersionKey: '04t000000000001',
    }));
  });

  it('should fail when PackageInstallRequest creation fails', async () => {
    mockToolingCreate.mockResolvedValue({
      errors: ['Bad request'],
      success: false,
    });

    const task = new ArtifactPackageInstallTask({devhub});
    const result = await task.execute(createMockOrg(), logger);

    expect(result.success).toBe(false);
    expect(result.error).toContain('Failed to create install request');
  });

  it('should fail when installation errors out', async () => {
    mockToolingCreate.mockResolvedValue({id: 'req-001', success: true});
    mockToolingRetrieve.mockResolvedValue({
      Errors: {errors: [{message: 'Dependency missing'}]},
      Status: 'ERROR',
    });

    const task = new ArtifactPackageInstallTask({devhub});
    const result = await task.execute(createMockOrg(), logger);

    expect(result.success).toBe(false);
    expect(result.error).toContain('Dependency missing');
  });

  it('should poll until success', async () => {
    vi.useFakeTimers();

    mockToolingCreate.mockResolvedValue({id: 'req-001', success: true});
    mockToolingRetrieve
      .mockResolvedValueOnce({Status: 'IN_PROGRESS'})
      .mockResolvedValueOnce({Status: 'IN_PROGRESS'})
      .mockResolvedValueOnce({Status: 'SUCCESS'});

    const task = new ArtifactPackageInstallTask({devhub});
    const promise = task.execute(createMockOrg(), logger);

    // Advance through the two 5-second poll intervals
    await vi.advanceTimersByTimeAsync(5000);
    await vi.advanceTimersByTimeAsync(5000);

    const result = await promise;

    expect(result.success).toBe(true);
    expect(mockToolingRetrieve).toHaveBeenCalledTimes(3);

    vi.useRealTimers();
  });

  it('should query released versions only', async () => {
    // Make it skip the install (already installed) so we only test version resolution
    mockIsSubscriberVersionInstalled.mockResolvedValue(true);

    const task = new ArtifactPackageInstallTask({devhub});
    await task.execute(createMockOrg(), logger);

    // getPackage2VersionById called with: packageId, undefined version, false (not validated), true (isReleased)
    expect(mockGetPackage2VersionById).toHaveBeenCalledWith(
      '0Ho000000000001',
      undefined,
      false,
      true,
    );
  });
});
