import {
  beforeEach, describe, expect, it, type Mock, vi,
} from 'vitest';

import type {ScratchOrg} from '../../src/org/scratch/types.js';
import type {DevHub, ScratchOrgCreateResult} from '../../src/types.js';

import OrgService from '../../src/org/org-service.js';
import {OrgError} from '../../src/types.js';

// ============================================================================
// Factories
// ============================================================================

function createMockDevHub(overrides: Partial<Record<keyof DevHub, Mock>> = {}): DevHub {
  return {
    createScratchOrg: vi.fn<() => Promise<ScratchOrgCreateResult>>().mockResolvedValue({
      loginUrl: 'https://test.salesforce.com',
      orgId: '00D000000000001',
      username: 'test-123@example.com',
    }),
    deleteActiveScratchOrgs: vi.fn<() => Promise<void>>().mockResolvedValue(),
    generatePassword: vi.fn().mockResolvedValue({password: 'P@ss1234'}),
    getJwtConfig: vi.fn().mockReturnValue({
      clientId: 'client-id',
      loginUrl: 'https://login.salesforce.com',
      privateKeyPath: '/path/to/key.pem',
    }),
    getOrphanedScratchOrgs: vi.fn<() => Promise<ScratchOrg[]>>().mockResolvedValue([]),
    getScratchOrgInfoByUsername: vi.fn<() => Promise<string | undefined>>().mockResolvedValue('a1B000000000001'),
    getScratchOrgUsageByUser: vi.fn().mockResolvedValue([]),
    getUserEmail: vi.fn<() => Promise<string>>().mockResolvedValue('user@example.com'),
    getUsername: vi.fn().mockReturnValue('devhub@example.com'),
    sendEmail: vi.fn<() => Promise<void>>().mockResolvedValue(),
    setAlias: vi.fn<() => Promise<void>>().mockResolvedValue(),
    setUserPassword: vi.fn<() => Promise<void>>().mockResolvedValue(),
    updateScratchOrgInfo: vi.fn<() => Promise<boolean>>().mockResolvedValue(true),
    ...overrides,
  };
}

function createMockLogger() {
  return {
    debug: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    trace: vi.fn(),
    warn: vi.fn(),
  };
}

function createScratchOrg(overrides: Partial<ScratchOrg> = {}): ScratchOrg {
  return {
    auth: {
      alias: 'my-org',
      loginUrl: 'https://test.salesforce.com',
      password: 'P@ss1234',
      username: 'test-123@example.com',
      ...overrides.auth,
    },
    orgId: overrides.orgId ?? '00D000000000001',
    ...overrides,
  };
}

// ============================================================================
// Tests
// ============================================================================

describe('OrgService', () => {
  let hub: DevHub;
  let service: OrgService;

  beforeEach(() => {
    hub = createMockDevHub();
    service = new OrgService(hub, createMockLogger());
  });

  // --------------------------------------------------------------------------
  // createScratchOrg
  // --------------------------------------------------------------------------
  describe('createScratchOrg', () => {
    const opts = {
      alias: 'my-org',
      definitionFile: 'config/project-scratch-def.json',
    };

    it('creates org, sets alias, generates password, returns ScratchOrg', async () => {
      const result = await service.createScratchOrg(opts);

      expect(hub.createScratchOrg).toHaveBeenCalledWith(expect.objectContaining({
        definitionFile: 'config/project-scratch-def.json',
        durationDays: 7,         // DEFAULT_SCRATCH_ORG.expiryDays
        noAncestors: false,      // DEFAULT_SCRATCH_ORG.noAncestors
        noNamespace: false,
        retries: 3,              // DEFAULT_SCRATCH_ORG.maxRetries
        waitMinutes: 6,          // DEFAULT_SCRATCH_ORG.waitMinutes
      }));

      expect(hub.setAlias).toHaveBeenCalledWith('test-123@example.com', 'my-org');
      expect(hub.generatePassword).toHaveBeenCalledWith('test-123@example.com');

      expect(result).toMatchObject({
        auth: {
          alias: 'my-org',
          loginUrl: 'https://test.salesforce.com',
          password: 'P@ss1234',
          username: 'test-123@example.com',
        },
        orgId: '00D000000000001',
      });
    });

    it('uses custom expiryDays and waitMinutes when provided', async () => {
      await service.createScratchOrg({
        ...opts,
        expiryDays: 14,
        noAncestors: true,
        waitMinutes: 10,
      });

      expect(hub.createScratchOrg).toHaveBeenCalledWith(expect.objectContaining({
        durationDays: 14,
        noAncestors: true,
        waitMinutes: 10,
      }));
    });

    it('emits scratch:create:start and scratch:create:complete events', async () => {
      const startSpy = vi.fn();
      const completeSpy = vi.fn();
      service.on('scratch:create:start', startSpy);
      service.on('scratch:create:complete', completeSpy);

      await service.createScratchOrg(opts);

      expect(startSpy).toHaveBeenCalledWith(expect.objectContaining({
        alias: 'my-org',
        definitionFile: 'config/project-scratch-def.json',
      }));
      expect(completeSpy).toHaveBeenCalledWith(expect.objectContaining({
        alias: 'my-org',
        orgId: '00D000000000001',
        username: 'test-123@example.com',
      }));
    });

    it('wraps creation failures in OrgError with cause', async () => {
      (hub.createScratchOrg as Mock).mockRejectedValue(new Error('API limit'));

      await expect(service.createScratchOrg(opts)).rejects.toThrow(OrgError);
      await expect(service.createScratchOrg(opts)).rejects.toThrow('Scratch org creation failed');
    });

    it('emits scratch:create:error on failure', async () => {
      (hub.createScratchOrg as Mock).mockRejectedValue(new Error('boom'));
      const errorSpy = vi.fn();
      service.on('scratch:create:error', errorSpy);

      await expect(service.createScratchOrg(opts)).rejects.toThrow();

      expect(errorSpy).toHaveBeenCalledWith(expect.objectContaining({
        alias: 'my-org',
        error: expect.any(String),
      }));
    });

    it('re-throws OrgError without wrapping', async () => {
      const original = new OrgError('password', 'Unable to generate password for scratch org');
      (hub.generatePassword as Mock).mockRejectedValue(original);

      const error = await service.createScratchOrg(opts).catch((error_: Error) => error_);
      expect(error).toBe(original);
    });

    it('throws OrgError when password is empty', async () => {
      (hub.generatePassword as Mock).mockResolvedValue({password: undefined});

      await expect(service.createScratchOrg(opts)).rejects.toThrow(OrgError);
      await expect(service.createScratchOrg(opts)).rejects.toThrow('Unable to generate password');
    });

    it('wraps non-Error causes in Error', async () => {
      (hub.createScratchOrg as Mock).mockRejectedValue('string-error');

      const error = await service.createScratchOrg(opts).catch((error_: OrgError) => error_);
      expect(error).toBeInstanceOf(OrgError);
      expect(error.cause).toBeInstanceOf(Error);
    });
  });

  // --------------------------------------------------------------------------
  // deleteScratchOrgs
  // --------------------------------------------------------------------------
  describe('deleteScratchOrgs', () => {
    it('delegates to hubOrg.deleteActiveScratchOrgs', async () => {
      const ids = ['a1B1', 'a1B2', 'a1B3'];
      await service.deleteScratchOrgs(ids);

      expect(hub.deleteActiveScratchOrgs).toHaveBeenCalledWith(ids);
    });

    it('emits scratch:delete:start and scratch:delete:complete', async () => {
      const startSpy = vi.fn();
      const completeSpy = vi.fn();
      service.on('scratch:delete:start', startSpy);
      service.on('scratch:delete:complete', completeSpy);

      const ids = ['a1B1'];
      await service.deleteScratchOrgs(ids);

      expect(startSpy).toHaveBeenCalledWith(expect.objectContaining({orgIds: ids}));
      expect(completeSpy).toHaveBeenCalledWith(expect.objectContaining({orgIds: ids}));
    });

    it('wraps errors in OrgError with context', async () => {
      (hub.deleteActiveScratchOrgs as Mock).mockRejectedValue(new Error('denied'));

      const error = await service.deleteScratchOrgs(['id1']).catch((error_: OrgError) => error_);
      expect(error).toBeInstanceOf(OrgError);
      expect(error.message).toContain('Failed to delete scratch orgs');
      expect(error.cause).toBeInstanceOf(Error);
    });

    it('does not emit complete event on failure', async () => {
      (hub.deleteActiveScratchOrgs as Mock).mockRejectedValue(new Error('fail'));
      const completeSpy = vi.fn();
      service.on('scratch:delete:complete', completeSpy);

      await expect(service.deleteScratchOrgs(['id1'])).rejects.toThrow();
      expect(completeSpy).not.toHaveBeenCalled();
    });
  });

  // --------------------------------------------------------------------------
  // getOrphanedScratchOrgs
  // --------------------------------------------------------------------------
  describe('getOrphanedScratchOrgs', () => {
    it('delegates to hubOrg and returns results', async () => {
      const orgs: ScratchOrg[] = [createScratchOrg({pool: undefined})];
      (hub.getOrphanedScratchOrgs as Mock).mockResolvedValue(orgs);

      const result = await service.getOrphanedScratchOrgs();
      expect(result).toBe(orgs);
      expect(hub.getOrphanedScratchOrgs).toHaveBeenCalled();
    });

    it('returns empty array when no orphaned orgs', async () => {
      const result = await service.getOrphanedScratchOrgs();
      expect(result).toEqual([]);
    });

    it('wraps errors in OrgError', async () => {
      (hub.getOrphanedScratchOrgs as Mock).mockRejectedValue(new Error('query failed'));

      await expect(service.getOrphanedScratchOrgs()).rejects.toThrow(OrgError);
      await expect(service.getOrphanedScratchOrgs()).rejects.toThrow('Failed to query orphaned');
    });
  });

  // --------------------------------------------------------------------------
  // getScratchOrgUsageByUser
  // --------------------------------------------------------------------------
  describe('getScratchOrgUsageByUser', () => {
    it('delegates to hubOrg and returns usage data', async () => {
      const usage = [
        {count: 5, email: 'alice@example.com'},
        {count: 2, email: 'bob@example.com'},
      ];
      (hub.getScratchOrgUsageByUser as Mock).mockResolvedValue(usage);

      const result = await service.getScratchOrgUsageByUser();
      expect(result).toBe(usage);
    });

    it('returns empty array when no usage data', async () => {
      const result = await service.getScratchOrgUsageByUser();
      expect(result).toEqual([]);
    });

    it('wraps errors in OrgError', async () => {
      (hub.getScratchOrgUsageByUser as Mock).mockRejectedValue(new Error('fail'));

      await expect(service.getScratchOrgUsageByUser()).rejects.toThrow(OrgError);
      await expect(service.getScratchOrgUsageByUser()).rejects.toThrow('Failed to query scratch org usage');
    });
  });

  // --------------------------------------------------------------------------
  // shareScratchOrg
  // --------------------------------------------------------------------------
  describe('shareScratchOrg', () => {
    const org = createScratchOrg();
    const shareOpts = {emailAddress: 'recipient@example.com'};

    it('sends email with org credentials', async () => {
      await service.shareScratchOrg(org, shareOpts);

      expect(hub.sendEmail).toHaveBeenCalledWith({
        body: expect.stringContaining('https://test.salesforce.com'),
        subject: expect.stringContaining('devhub@example.com'),
        to: 'recipient@example.com',
      });
    });

    it('email body contains username and password', async () => {
      await service.shareScratchOrg(org, shareOpts);

      const {body} = (hub.sendEmail as Mock).mock.calls[0][0];
      expect(body).toContain('test-123@example.com');
      expect(body).toContain('P@ss1234');
    });

    it('email body contains sf login command', async () => {
      await service.shareScratchOrg(org, shareOpts);

      const {body} = (hub.sendEmail as Mock).mock.calls[0][0];
      expect(body).toContain('sf org login web --instance-url');
    });

    it('emits scratch:share:complete on success', async () => {
      const spy = vi.fn();
      service.on('scratch:share:complete', spy);

      await service.shareScratchOrg(org, shareOpts);

      expect(spy).toHaveBeenCalledWith(expect.objectContaining({
        emailAddress: 'recipient@example.com',
        username: 'test-123@example.com',
      }));
    });

    it('wraps errors in OrgError with orgIdentifier', async () => {
      (hub.sendEmail as Mock).mockRejectedValue(new Error('email fail'));

      const error = await service.shareScratchOrg(org, shareOpts).catch((error_: OrgError) => error_);
      expect(error).toBeInstanceOf(OrgError);
      expect(error.message).toContain('recipient@example.com');
    });
  });

  // --------------------------------------------------------------------------
  // updateScratchOrgStatus
  // --------------------------------------------------------------------------
  describe('updateScratchOrgStatus', () => {
    it('resolves ScratchOrgInfo record and updates Allocation_Status__c', async () => {
      const result = await service.updateScratchOrgStatus('test@example.com', 'Available');

      expect(hub.getScratchOrgInfoByUsername).toHaveBeenCalledWith('test@example.com');
      expect(hub.updateScratchOrgInfo).toHaveBeenCalledWith({
        Allocation_Status__c: 'Available',
        Id: 'a1B000000000001',
      });
      expect(result).toBe(true);
    });

    it('emits scratch:status:complete on success', async () => {
      const spy = vi.fn();
      service.on('scratch:status:complete', spy);

      await service.updateScratchOrgStatus('test@example.com', 'Assigned');

      expect(spy).toHaveBeenCalledWith(expect.objectContaining({
        status: 'Assigned',
        username: 'test@example.com',
      }));
    });

    it('throws OrgError when ScratchOrgInfo not found', async () => {
      (hub.getScratchOrgInfoByUsername as Mock).mockResolvedValue();

      const error = await service.updateScratchOrgStatus('missing@example.com', 'Available').catch((error_: OrgError) => error_);
      expect(error).toBeInstanceOf(OrgError);
      expect(error.message).toContain('ScratchOrgInfo record not found');
    });

    it('wraps update failures in OrgError with context', async () => {
      (hub.updateScratchOrgInfo as Mock).mockRejectedValue(new Error('update denied'));

      const error = await service.updateScratchOrgStatus('test@example.com', 'Return').catch((error_: OrgError) => error_);
      expect(error).toBeInstanceOf(OrgError);
      expect(error.message).toContain('Failed to update scratch org status');
    });

    it('returns false when update reports failure', async () => {
      (hub.updateScratchOrgInfo as Mock).mockResolvedValue(false);

      const result = await service.updateScratchOrgStatus('test@example.com', 'Available');
      expect(result).toBe(false);
    });
  });

  // --------------------------------------------------------------------------
  // EventEmitter behavior
  // --------------------------------------------------------------------------
  describe('event emitter', () => {
    it('is an EventEmitter', () => {
      expect(service).toHaveProperty('on');
      expect(service).toHaveProperty('emit');
    });

    it('supports listener removal', async () => {
      const spy = vi.fn();
      service.on('scratch:delete:complete', spy);
      service.off('scratch:delete:complete', spy);

      await service.deleteScratchOrgs(['id1']);
      expect(spy).not.toHaveBeenCalled();
    });
  });

  // --------------------------------------------------------------------------
  // Works without logger
  // --------------------------------------------------------------------------
  describe('without logger', () => {
    it('operates normally without logger', async () => {
      const noLogService = new OrgService(hub);
      const result = await noLogService.createScratchOrg({
        alias: 'no-log',
        definitionFile: 'def.json',
      });
      expect(result.auth.username).toBe('test-123@example.com');
    });
  });

  // --------------------------------------------------------------------------
  // formatElapsed (tested indirectly via logger output)
  // --------------------------------------------------------------------------
  describe('formatElapsed (indirect)', () => {
    it('logs seconds for short durations', async () => {
      const logger = createMockLogger();
      const svc = new OrgService(hub, logger);
      await svc.createScratchOrg({alias: 'a', definitionFile: 'd.json'});

      const infoCall = logger.info.mock.calls.find((c: string[]) => typeof c[0] === 'string' && c[0].includes('created successfully'));
      expect(infoCall).toBeDefined();
      expect(infoCall![0]).toMatch(/\d+s/);
    });
  });
});
