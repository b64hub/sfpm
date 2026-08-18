import type {Logger} from '@b64hub/sfpm-core';
import type {Org} from '@salesforce/core';

import {
  beforeEach, describe, expect, it, vi,
} from 'vitest';

import type {PoolOrg} from '../../../src/org/pool-org.js';

import {SfpmPackageInstallTask} from '../../../src/pool/tasks/sfpm-package-install-task.js';

// ============================================================================
// Mocks
// ============================================================================

const mockQuery = vi.fn();
const mockSobjectCreate = vi.fn();
const mockConnection = {
  query: mockQuery,
  sobject: vi.fn(() => ({create: mockSobjectCreate})),
};
const mockScratchOrg = {
  getConnection: vi.fn().mockReturnValue(mockConnection),
};

vi.mock('@salesforce/core', () => ({
  Org: {
    create: vi.fn().mockImplementation(() => mockScratchOrg),
  },
}));

const mockListPackages = vi.fn();
const mockListPackageVersions = vi.fn();
const mockIsSubscriberVersionInstalled = vi.fn();
const mockInstallPackage = vi.fn();

vi.mock('@b64hub/sfpm-core', () => ({
  escapeSOQL: (v: string) => v,
  PackageService: vi.fn(function (this: Record<string, unknown>) {
    this.installPackage = mockInstallPackage;
    this.isSubscriberVersionInstalled = mockIsSubscriberVersionInstalled;
    this.listPackages = mockListPackages;
    this.listPackageVersions = mockListPackageVersions;
  }),
  soql: (strings: TemplateStringsArray, ...values: unknown[]) => strings.reduce((r, s, i) => r + s + (values[i] ?? ''), ''),
}));

// ============================================================================
// Helpers
// ============================================================================

function createMockDevhub(): Org {
  return {} as unknown as Org;
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
    debug: vi.fn(), error: vi.fn(), info: vi.fn(), trace: vi.fn(), warn: vi.fn(),
  };
}

// ============================================================================
// Tests
// ============================================================================

describe('SfpmPackageInstallTask', () => {
  let devhub: Org;
  let logger: Logger;

  beforeEach(() => {
    vi.clearAllMocks();
    devhub = createMockDevhub();
    logger = createMockLogger();

    mockListPackages.mockResolvedValue([{Id: '0Ho000000000001', Name: 'sfpm-artifact'}]);
    mockListPackageVersions.mockResolvedValue([{SubscriberPackageVersionId: '04t000000000001'}]);
    mockIsSubscriberVersionInstalled.mockResolvedValue(false);
    mockInstallPackage.mockResolvedValue({Id: 'req-001', Status: 'SUCCESS'});

    // User lookup, permission set lookup, existing-assignment lookup (in call order)
    mockQuery
    .mockResolvedValueOnce({records: [{Id: '005000000000001'}]}) // User
    .mockResolvedValueOnce({records: [{Id: '0PS000000000001'}]}) // PermissionSet
    .mockResolvedValueOnce({records: []}); // no existing assignment
    mockSobjectCreate.mockResolvedValue({id: 'PSA000000000001', success: true});
  });

  it('fails when package is not found on the DevHub', async () => {
    mockListPackages.mockResolvedValue([]);

    const task = new SfpmPackageInstallTask({devhub});
    const result = await task.execute(createMockOrg(), logger);

    expect(result.success).toBe(false);
    expect(result.error).toContain('not found on the DevHub');
    expect(mockInstallPackage).not.toHaveBeenCalled();
  });

  it('installs via PackageService.installPackage when not already installed', async () => {
    const task = new SfpmPackageInstallTask({devhub});
    const result = await task.execute(createMockOrg(), logger);

    expect(result.success).toBe(true);
    expect(mockInstallPackage).toHaveBeenCalledWith('04t000000000001', expect.objectContaining({
      apexCompile: 'package',
      securityType: 'AllUsers',
    }));
  });

  it('skips install (but still assigns the permission set) when already installed', async () => {
    mockIsSubscriberVersionInstalled.mockResolvedValue(true);

    const task = new SfpmPackageInstallTask({devhub});
    const result = await task.execute(createMockOrg(), logger);

    expect(result.success).toBe(true);
    expect(mockInstallPackage).not.toHaveBeenCalled();
    expect(mockSobjectCreate).toHaveBeenCalledWith({AssigneeId: '005000000000001', PermissionSetId: '0PS000000000001'});
  });

  it('returns an error and skips permission set assignment when install fails', async () => {
    mockInstallPackage.mockRejectedValue(new Error('INSTALL_ERROR: something went wrong'));

    const task = new SfpmPackageInstallTask({devhub});
    const result = await task.execute(createMockOrg(), logger);

    expect(result.success).toBe(false);
    expect(result.error).toContain('INSTALL_ERROR');
    expect(mockSobjectCreate).not.toHaveBeenCalled();
  });

  it('assigns the Manage_Artifacts permission set to the running user after install', async () => {
    const task = new SfpmPackageInstallTask({devhub});
    await task.execute(createMockOrg('someone@scratch.org'), logger);

    expect(mockSobjectCreate).toHaveBeenCalledWith({AssigneeId: '005000000000001', PermissionSetId: '0PS000000000001'});
  });

  it('does not create a duplicate assignment when one already exists', async () => {
    mockQuery
    .mockReset()
    .mockResolvedValueOnce({records: [{Id: '005000000000001'}]})
    .mockResolvedValueOnce({records: [{Id: '0PS000000000001'}]})
    .mockResolvedValueOnce({records: [{Id: 'PSA-existing'}]});

    const task = new SfpmPackageInstallTask({devhub});
    const result = await task.execute(createMockOrg(), logger);

    expect(result.success).toBe(true);
    expect(mockSobjectCreate).not.toHaveBeenCalled();
  });

  it('degrades gracefully (task still succeeds) when the permission set is not found', async () => {
    mockQuery
    .mockReset()
    .mockResolvedValueOnce({records: [{Id: '005000000000001'}]}) // User found
    .mockResolvedValueOnce({records: []}); // PermissionSet not found

    const task = new SfpmPackageInstallTask({devhub});
    const result = await task.execute(createMockOrg(), logger);

    expect(result.success).toBe(true);
    expect(mockSobjectCreate).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('Manage_Artifacts'));
  });

  it('degrades gracefully (task still succeeds) when the assignment write throws', async () => {
    mockSobjectCreate.mockRejectedValue(new Error('DUPLICATE_VALUE'));

    const task = new SfpmPackageInstallTask({devhub});
    const result = await task.execute(createMockOrg(), logger);

    expect(result.success).toBe(true);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('Failed to assign'));
  });
});
