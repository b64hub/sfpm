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
    },
    Org: {
      create: vi.fn().mockResolvedValue({}),
    },
  };
});

import {AuthInfo, Org} from '@salesforce/core';

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
    kind: 'scratchOrg',
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
    it('should authenticate using auth URL when present', async () => {
      const service = new AuthService('hub@example.com');
      const org = createOrg({authUrl: 'force://token@instance.salesforce.com', username: 'user@test.org'});

      await service.login(org);

      expect(AuthInfo.create).toHaveBeenCalledWith({
        authUrl: 'force://token@instance.salesforce.com',
        username: 'user@test.org',
      });

      const mockAuthInfo = await (AuthInfo.create as ReturnType<typeof vi.fn>).mock.results[0].value;
      expect(mockAuthInfo.save).toHaveBeenCalled();
      expect(Org.create).toHaveBeenCalledWith({aliasOrUsername: 'user@test.org'});
    });

    it('should throw wrapped error when auth URL login fails', async () => {
      (AuthInfo.create as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('Invalid auth URL'));

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
      const service = new AuthService('hub@example.com', jwtConfig);
      const org = createOrg({username: 'user@test.org'});

      await service.login(org);

      expect(AuthInfo.create).toHaveBeenCalledWith({
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
      (AuthInfo.create as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('JWT expired'));

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
});
