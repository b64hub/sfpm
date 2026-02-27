import {
  beforeEach, describe, expect, it, vi,
} from 'vitest';

import PoolFetcher from '../../src/pool/pool-fetcher.js';

// ============================================================================
// Test Helpers
// ============================================================================

function createMockOrgSource() {
  return {
    claimOrg: vi.fn(),
    getAvailableByTag: vi.fn(),
    getOrgsByTag: vi.fn(),
    getRecordIds: vi.fn(),
    setAlias: vi.fn(),
    setUserPassword: vi.fn(),
    updatePoolMetadata: vi.fn(),
  };
}

function createMockAuthenticator() {
  return {
    enableSourceTracking: vi.fn(),
    hasValidAuth: vi.fn().mockReturnValue(true),
    login: vi.fn().mockResolvedValue(undefined),
  };
}

function createScratchOrg(overrides?: Record<string, unknown>) {
  const username = (overrides?.username as string) ?? `org-${Math.random().toString(36).slice(2, 8)}@scratch.org`;
  return {
    auth: {
      authUrl: 'force://PlatformCLI::auth...',
      loginUrl: 'https://test.salesforce.com',
      password: 'pw-123',
      username,
      ...(overrides?.auth as Record<string, unknown>),
    },
    orgId: (overrides?.orgId as string) ?? '00D000000000001',
    pool: {
      status: 'Available',
      tag: 'test-pool',
      timestamp: Date.now(),
      ...(overrides?.pool as Record<string, unknown>),
    },
    recordId: (overrides?.recordId as string) ?? 'a00000000000001',
  };
}

// ============================================================================
// PoolFetcher Tests
// ============================================================================

describe('PoolFetcher', () => {
  let orgSource: ReturnType<typeof createMockOrgSource>;
  let authenticator: ReturnType<typeof createMockAuthenticator>;

  beforeEach(() => {
    orgSource = createMockOrgSource();
    authenticator = createMockAuthenticator();
  });

  // ==========================================================================
  // fetch (single org)
  // ==========================================================================

  describe('fetch', () => {
    it('should claim the first available org', async () => {
      const org = createScratchOrg({username: 'claimed@scratch.org'});
      orgSource.getAvailableByTag.mockResolvedValue([org]);
      orgSource.claimOrg.mockResolvedValue(true);

      const fetcher = new PoolFetcher(
        orgSource as any,
        authenticator as any,
      );

      const result = await fetcher.fetch({tag: 'test-pool'});

      expect(orgSource.claimOrg).toHaveBeenCalledWith('a00000000000001');
      expect(result.auth.username).toBe('claimed@scratch.org');
      expect(result.pool?.status).toBe('Assigned');
    });

    it('should skip orgs that fail claiming and try next', async () => {
      const org1 = createScratchOrg({recordId: 'r1', username: 'taken@scratch.org'});
      const org2 = createScratchOrg({recordId: 'r2', username: 'available@scratch.org'});
      orgSource.getAvailableByTag.mockResolvedValue([org1, org2]);
      orgSource.claimOrg
      .mockResolvedValueOnce(false) // org1 already claimed
      .mockResolvedValueOnce(true); // org2 succeeds

      const fetcher = new PoolFetcher(
        orgSource as any,
        authenticator as any,
      );

      const result = await fetcher.fetch({tag: 'test-pool'});

      expect(orgSource.claimOrg).toHaveBeenCalledTimes(2);
      expect(result.auth.username).toBe('available@scratch.org');
    });

    it('should throw when no orgs are available in pool', async () => {
      orgSource.getAvailableByTag.mockResolvedValue([]);

      const fetcher = new PoolFetcher(
        orgSource as any,
        authenticator as any,
      );

      await expect(fetcher.fetch({tag: 'empty-pool'})).rejects.toThrow('No scratch orgs available for pool "empty-pool"');
    });

    it('should throw when all claim attempts fail', async () => {
      const org = createScratchOrg();
      orgSource.getAvailableByTag.mockResolvedValue([org]);
      orgSource.claimOrg.mockResolvedValue(false);

      const fetcher = new PoolFetcher(
        orgSource as any,
        authenticator as any,
      );

      await expect(fetcher.fetch({tag: 'test-pool'})).rejects.toThrow('No scratch org could be claimed');
    });

    it('should authenticate after claiming', async () => {
      const org = createScratchOrg();
      orgSource.getAvailableByTag.mockResolvedValue([org]);
      orgSource.claimOrg.mockResolvedValue(true);

      const fetcher = new PoolFetcher(
        orgSource as any,
        authenticator as any,
      );

      await fetcher.fetch({tag: 'test-pool'});

      expect(authenticator.login).toHaveBeenCalledWith(expect.objectContaining({
        auth: expect.objectContaining({username: org.auth.username}),
      }));
    });

    it('should enable source tracking when requested', async () => {
      const org = createScratchOrg();
      orgSource.getAvailableByTag.mockResolvedValue([org]);
      orgSource.claimOrg.mockResolvedValue(true);

      const fetcher = new PoolFetcher(
        orgSource as any,
        authenticator as any,
      );

      await fetcher.fetch({enableSourceTracking: true, tag: 'test-pool'});

      expect(authenticator.enableSourceTracking).toHaveBeenCalledWith(expect.objectContaining({auth: expect.objectContaining({username: org.auth.username})}));
    });

    it('should invoke postClaimAction when sendToUser is set', async () => {
      const org = createScratchOrg();
      orgSource.getAvailableByTag.mockResolvedValue([org]);
      orgSource.claimOrg.mockResolvedValue(true);

      const postClaimAction = vi.fn().mockResolvedValue(undefined);

      const fetcher = new PoolFetcher(
        orgSource as any,
        authenticator as any,
      );

      await fetcher.fetch({postClaimAction, sendToUser: 'someone@company.com', tag: 'test-pool'});

      expect(postClaimAction).toHaveBeenCalledWith(
        expect.objectContaining({auth: expect.objectContaining({username: org.auth.username})}),
        expect.objectContaining({sendToUser: 'someone@company.com'}),
      );
      expect(authenticator.login).not.toHaveBeenCalled();
    });

    it('should filter by auth validity when requireValidAuth is set', async () => {
      const orgValid = createScratchOrg({auth: {authUrl: 'valid'}, username: 'valid@scratch.org'});
      const orgInvalid = createScratchOrg({auth: {authUrl: undefined}, username: 'invalid@scratch.org'});
      orgSource.getAvailableByTag.mockResolvedValue([orgValid, orgInvalid]);
      authenticator.hasValidAuth
      .mockReturnValueOnce(true)
      .mockReturnValueOnce(false);
      orgSource.claimOrg.mockResolvedValue(true);

      const fetcher = new PoolFetcher(
        orgSource as any,
        authenticator as any,
      );

      const result = await fetcher.fetch({requireValidAuth: true, tag: 'test-pool'});

      expect(result.auth.username).toBe('valid@scratch.org');
    });

    it('should throw when no orgs pass auth validity filter', async () => {
      const org = createScratchOrg();
      orgSource.getAvailableByTag.mockResolvedValue([org]);
      authenticator.hasValidAuth.mockReturnValue(false);

      const fetcher = new PoolFetcher(
        orgSource as any,
        authenticator as any,
      );

      await expect(fetcher.fetch({requireValidAuth: true, tag: 'test-pool'})).rejects.toThrow('No scratch orgs with valid auth credentials');
    });

    it('should pass myPool flag to orgSource', async () => {
      orgSource.getAvailableByTag.mockResolvedValue([]);

      const fetcher = new PoolFetcher(
        orgSource as any,
        authenticator as any,
      );

      await expect(fetcher.fetch({myPool: true, tag: 'test-pool'})).rejects.toThrow();

      expect(orgSource.getAvailableByTag).toHaveBeenCalledWith('test-pool', true);
    });

    it('should emit fetch events', async () => {
      const org = createScratchOrg();
      orgSource.getAvailableByTag.mockResolvedValue([org]);
      orgSource.claimOrg.mockResolvedValue(true);

      const fetcher = new PoolFetcher(
        orgSource as any,
        authenticator as any,
      );

      const events: string[] = [];
      fetcher.on('pool:fetch:start', () => events.push('start'));
      fetcher.on('pool:fetch:claimed', () => events.push('claimed'));
      fetcher.on('pool:fetch:complete', () => events.push('complete'));

      await fetcher.fetch({tag: 'test-pool'});

      expect(events).toEqual(['start', 'claimed', 'complete']);
    });
  });

  // ==========================================================================
  // fetchAll (multiple orgs)
  // ==========================================================================

  describe('fetchAll', () => {
    it('should return all available orgs without claiming', async () => {
      const org1 = createScratchOrg({username: 'a@scratch.org'});
      const org2 = createScratchOrg({username: 'b@scratch.org'});
      orgSource.getAvailableByTag.mockResolvedValue([org1, org2]);

      const fetcher = new PoolFetcher(
        orgSource as any,
        authenticator as any,
      );

      const result = await fetcher.fetchAll({tag: 'test-pool'});

      expect(orgSource.claimOrg).not.toHaveBeenCalled();
      expect(result).toHaveLength(2);
    });

    it('should apply limit to returned orgs', async () => {
      const orgs = Array.from({length: 10}, (_, i) =>
        createScratchOrg({username: `org${i}@scratch.org`}));
      orgSource.getAvailableByTag.mockResolvedValue(orgs);

      const fetcher = new PoolFetcher(
        orgSource as any,
        authenticator as any,
      );

      const result = await fetcher.fetchAll({limit: 3, tag: 'test-pool'});

      expect(result).toHaveLength(3);
    });

    it('should assign sequential aliases', async () => {
      const org1 = createScratchOrg();
      const org2 = createScratchOrg();
      orgSource.getAvailableByTag.mockResolvedValue([org1, org2]);

      const fetcher = new PoolFetcher(
        orgSource as any,
        authenticator as any,
      );

      const result = await fetcher.fetchAll({tag: 'test-pool'});

      expect(result[0].auth.alias).toBe('SO1');
      expect(result[1].auth.alias).toBe('SO2');
    });

    it('should authenticate orgs and filter out failures', async () => {
      const org1 = createScratchOrg({username: 'good@scratch.org'});
      const org2 = createScratchOrg({username: 'bad@scratch.org'});
      orgSource.getAvailableByTag.mockResolvedValue([org1, org2]);
      authenticator.login
      .mockResolvedValueOnce(undefined) // org1 passes
      .mockRejectedValueOnce(new Error('Auth failed')); // org2 fails

      const fetcher = new PoolFetcher(
        orgSource as any,
        authenticator as any,
      );

      const result = await fetcher.fetchAll({tag: 'test-pool'});

      expect(result).toHaveLength(1);
    });

    it('should skip authentication when sendToUser is set', async () => {
      const org = createScratchOrg();
      orgSource.getAvailableByTag.mockResolvedValue([org]);

      const fetcher = new PoolFetcher(
        orgSource as any,
        authenticator as any,
      );

      const result = await fetcher.fetchAll({sendToUser: 'user@company.com', tag: 'test-pool'});

      expect(authenticator.login).not.toHaveBeenCalled();
      expect(result).toHaveLength(1);
    });

    it('should throw when no orgs are available', async () => {
      orgSource.getAvailableByTag.mockResolvedValue([]);

      const fetcher = new PoolFetcher(
        orgSource as any,
        authenticator as any,
      );

      await expect(fetcher.fetchAll({tag: 'empty-pool'})).rejects.toThrow('No scratch orgs available for pool "empty-pool"');
    });

    it('should emit start and complete events', async () => {
      const org = createScratchOrg();
      orgSource.getAvailableByTag.mockResolvedValue([org]);

      const fetcher = new PoolFetcher(
        orgSource as any,
        authenticator as any,
      );

      const events: string[] = [];
      fetcher.on('pool:fetch:start', () => events.push('start'));
      fetcher.on('pool:fetch:complete', () => events.push('complete'));

      await fetcher.fetchAll({tag: 'test-pool'});

      expect(events).toEqual(['start', 'complete']);
    });
  });
});
