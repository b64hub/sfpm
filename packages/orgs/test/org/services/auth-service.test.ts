import {
  beforeEach, describe, expect, it, vi,
} from 'vitest';

import type {PoolOrg} from '../../../src/org/pool-org.js';

// Mock @salesforce/core before importing the class under test
vi.mock('@salesforce/core', () => {
  const mockAuthInfo = {
    save: vi.fn().mockResolvedValue(undefined),
    update: vi.fn(),
  };
  return {
    AuthInfo: {
      create: vi.fn().mockResolvedValue(mockAuthInfo),
      parseSfdxAuthUrl: vi.fn().mockReturnValue({
        clientId: 'parsed-client-id',
        clientSecret: 'parsed-client-secret',
        loginUrl: 'https://parsed.salesforce.com',
        refreshToken: 'parsed-refresh-token',
      }),
    },
    Org: {
      create: vi.fn().mockResolvedValue({}),
    },
    SfProject: {
      resolve: vi.fn(),
    },
  };
});

vi.mock('@salesforce/source-tracking', () => ({
  SourceTracking: {create: vi.fn()},
}));

import {AuthInfo, Org, SfProject} from '@salesforce/core';
import {SourceTracking} from '@salesforce/source-tracking';

import AuthService from '../../../src/org/services/auth-service.js';

// ============================================================================
// Test Helpers
// ============================================================================

function createOrg(overrides?: Partial<PoolOrg['auth']>): PoolOrg {
  return {
    auth: {
      username: 'test@scratch.org',
      ...overrides,
    },
    orgType: 'scratch' as any,
    orgId: '00D000000000001',
  };
}

const jwtConfig = {
  clientId: 'PlatformCLI',
  loginUrl: 'https://login.salesforce.com',
  privateKeyPath: '/path/to/key.pem',
};

// ============================================================================
// Tests
// ============================================================================

describe('AuthService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // --------------------------------------------------------------------------
  // hasValidAuth
  // --------------------------------------------------------------------------

  describe('hasValidAuth', () => {
    it('should return true when auth URL is present', () => {
      const service = new AuthService('hub@example.com');
      const org = createOrg({authUrl: 'force://token@instance.salesforce.com'});

      expect(service.hasValidAuth(org)).toBe(true);
    });

    it('should return true when JWT config and required fields are present', () => {
      const service = new AuthService('hub@example.com', jwtConfig);
      const org = createOrg({loginUrl: 'https://test.salesforce.com', username: 'user@test.org'});

      expect(service.hasValidAuth(org)).toBe(true);
    });

    it('should return false when no auth URL and no JWT config', () => {
      const service = new AuthService('hub@example.com');
      const org = createOrg();

      expect(service.hasValidAuth(org)).toBe(false);
    });

    it('should return false when JWT config present but no loginUrl on org', () => {
      const service = new AuthService('hub@example.com', jwtConfig);
      const org = createOrg(); // no loginUrl

      expect(service.hasValidAuth(org)).toBe(false);
    });
  });

  // --------------------------------------------------------------------------
  // login — auth URL path
  // --------------------------------------------------------------------------

  describe('login — auth URL', () => {
    it('should authenticate using auth URL when not already authenticated locally', async () => {
      (AuthInfo.create as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('NamedOrgNotFoundError'));

      const service = new AuthService('hub@example.com');
      const org = createOrg({authUrl: 'force://token@instance.salesforce.com', username: 'user@test.org'});

      await service.login(org);

      expect(AuthInfo.parseSfdxAuthUrl).toHaveBeenCalledWith('force://token@instance.salesforce.com');
      expect(AuthInfo.create).toHaveBeenNthCalledWith(1, {username: 'user@test.org'});
      expect(AuthInfo.create).toHaveBeenNthCalledWith(2, {
        oauth2Options: {
          clientId: 'parsed-client-id',
          clientSecret: 'parsed-client-secret',
          loginUrl: 'https://parsed.salesforce.com',
          refreshToken: 'parsed-refresh-token',
        },
        username: 'user@test.org',
      });

      const mockAuthInfo = await (AuthInfo.create as ReturnType<typeof vi.fn>).mock.results[1].value;
      expect(mockAuthInfo.save).toHaveBeenCalled();
      expect(Org.create).toHaveBeenCalledWith({aliasOrUsername: 'user@test.org'});
    });

    it('should skip re-authentication when the org is already authenticated locally', async () => {
      const service = new AuthService('hub@example.com');
      const org = createOrg({authUrl: 'force://token@instance.salesforce.com', username: 'user@test.org'});

      await service.login(org);

      expect(AuthInfo.create).toHaveBeenCalledTimes(1);
      expect(AuthInfo.create).toHaveBeenCalledWith({username: 'user@test.org'});
      expect(Org.create).toHaveBeenCalledWith({aliasOrUsername: 'user@test.org'});
    });

    it('should throw wrapped error when auth URL login fails', async () => {
      (AuthInfo.create as ReturnType<typeof vi.fn>)
      .mockRejectedValueOnce(new Error('NamedOrgNotFoundError'))
      .mockRejectedValueOnce(new Error('Invalid auth URL'));

      const service = new AuthService('hub@example.com');
      const org = createOrg({authUrl: 'force://bad@url', username: 'user@test.org'});

      await expect(service.login(org)).rejects.toThrow('Auth URL login failed for user@test.org: Invalid auth URL');
    });
  });

  // --------------------------------------------------------------------------
  // login — JWT fallback
  // --------------------------------------------------------------------------

  describe('login — JWT fallback', () => {
    it('should fall back to JWT when no auth URL is present', async () => {
      (AuthInfo.create as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('NamedOrgNotFoundError'));

      const service = new AuthService('hub@example.com', jwtConfig);
      const org = createOrg({username: 'user@test.org'});

      await service.login(org);

      expect(AuthInfo.create).toHaveBeenNthCalledWith(2, {
        oauth2Options: {
          clientId: 'PlatformCLI',
          loginUrl: 'https://login.salesforce.com',
          privateKeyFile: '/path/to/key.pem',
        },
        parentUsername: 'hub@example.com',
        username: 'user@test.org',
      });
    });

    it('should throw wrapped error when JWT login fails', async () => {
      (AuthInfo.create as ReturnType<typeof vi.fn>)
      .mockRejectedValueOnce(new Error('NamedOrgNotFoundError'))
      .mockRejectedValueOnce(new Error('JWT expired'));

      const service = new AuthService('hub@example.com', jwtConfig);
      const org = createOrg({username: 'user@test.org'});

      await expect(service.login(org)).rejects.toThrow('JWT login failed for user@test.org: JWT expired');
    });
  });

  // --------------------------------------------------------------------------
  // login — no auth method
  // --------------------------------------------------------------------------

  describe('login — no auth method', () => {
    it('should throw when no auth URL and no JWT config', async () => {
      (AuthInfo.create as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('NamedOrgNotFoundError'));

      const service = new AuthService('hub@example.com');
      const org = createOrg({username: 'user@test.org'});

      await expect(service.login(org)).rejects.toThrow(
        'No authentication method available for user@test.org',
      );
    });

    it('should throw when username is missing', async () => {
      const service = new AuthService('hub@example.com', jwtConfig);
      const org = createOrg({username: undefined as any});

      await expect(service.login(org)).rejects.toThrow('Login error: org must have a valid username');
    });
  });

  // --------------------------------------------------------------------------
  // enableSourceTracking
  // --------------------------------------------------------------------------

  describe('enableSourceTracking', () => {
    it('should update AuthInfo with tracksSource', async () => {
      const service = new AuthService('hub@example.com');
      const org = createOrg({username: 'user@test.org'});

      await service.enableSourceTracking(org);

      expect(AuthInfo.create).toHaveBeenCalledWith({username: 'user@test.org'});
      const mockAuthInfo = await (AuthInfo.create as ReturnType<typeof vi.fn>).mock.results[0].value;
      expect(mockAuthInfo.update).toHaveBeenCalledWith({tracksSource: true});
      expect(mockAuthInfo.save).toHaveBeenCalled();
    });

    it('should skip when username is missing', async () => {
      const service = new AuthService('hub@example.com');
      const org = createOrg({username: undefined as any});

      await service.enableSourceTracking(org);

      expect(AuthInfo.create).not.toHaveBeenCalled();
    });
  });

  // --------------------------------------------------------------------------
  // resetSourceTracking
  // --------------------------------------------------------------------------

  describe('resetSourceTracking', () => {
    it('should reset local and remote tracking when the org supports source tracking', async () => {
      const service = new AuthService('hub@example.com');
      const org = createOrg({username: 'user@test.org'});
      const sfOrg = {supportsSourceTracking: vi.fn().mockResolvedValue(true)};
      const project = {};
      const tracking = {
        resetLocalTracking: vi.fn().mockResolvedValue([]),
        resetRemoteTracking: vi.fn().mockResolvedValue(0),
      };
      vi.mocked(Org.create).mockResolvedValueOnce(sfOrg as never);
      vi.mocked(SfProject.resolve).mockResolvedValueOnce(project as never);
      vi.mocked(SourceTracking.create).mockResolvedValueOnce(tracking as never);

      await service.resetSourceTracking(org);

      expect(SourceTracking.create).toHaveBeenCalledWith({org: sfOrg, project});
      expect(tracking.resetLocalTracking).toHaveBeenCalledTimes(1);
      expect(tracking.resetRemoteTracking).toHaveBeenCalledTimes(1);
    });

    it('should do nothing when the org does not support source tracking', async () => {
      const service = new AuthService('hub@example.com');
      const org = createOrg({username: 'user@test.org'});
      vi.mocked(Org.create).mockResolvedValueOnce({supportsSourceTracking: vi.fn().mockResolvedValue(false)} as never);

      await expect(service.resetSourceTracking(org)).resolves.toBeUndefined();

      expect(SourceTracking.create).not.toHaveBeenCalled();
    });

    it('should reject when the project cannot be resolved', async () => {
      const service = new AuthService('hub@example.com');
      const org = createOrg({username: 'user@test.org'});
      const error = new Error('no sfdx-project.json');
      vi.mocked(Org.create).mockResolvedValueOnce({supportsSourceTracking: vi.fn().mockResolvedValue(true)} as never);
      vi.mocked(SfProject.resolve).mockRejectedValueOnce(error);

      await expect(service.resetSourceTracking(org)).rejects.toBe(error);
    });

    it('should skip when username is missing', async () => {
      const service = new AuthService('hub@example.com');
      const org = createOrg({username: undefined as never});

      await service.resetSourceTracking(org);

      expect(Org.create).not.toHaveBeenCalled();
    });
  });
});
