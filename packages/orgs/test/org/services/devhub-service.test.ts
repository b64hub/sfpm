import {
  beforeEach, describe, expect, it, vi,
} from 'vitest';

import {OrgError} from '../../../src/org/types.js';
import DevHubService from '../../../src/org/services/devhub-service.js';

// ============================================================================
// Test Helpers
// ============================================================================

/**
 * Create a mock Org instance with stubbed connection and methods.
 */
function createMockOrg() {
  const mockConnection = {
    getApiVersion: vi.fn().mockReturnValue('62.0'),
    getAuthInfoFields: vi.fn().mockReturnValue({
      clientId: 'test-client-id',
      loginUrl: 'https://login.salesforce.com',
      privateKey: '/path/to/key.pem',
    }),
    query: vi.fn(),
    request: vi.fn(),
  };

  const mockOrg = {
    getConnection: vi.fn().mockReturnValue(mockConnection),
    getUsername: vi.fn().mockReturnValue('devhub@example.com'),
  };

  return {connection: mockConnection, org: mockOrg};
}

// ============================================================================
// DevHubService Tests
// ============================================================================

describe('DevHubService', () => {
  let devHub: DevHubService;
  let conn: ReturnType<typeof createMockOrg>['connection'];

  beforeEach(() => {
    const mocks = createMockOrg();
    conn = mocks.connection;
    devHub = new DevHubService(mocks.org as any);
  });

  // --------------------------------------------------------------------------
  // getJwtConfig
  // --------------------------------------------------------------------------

  describe('getJwtConfig', () => {
    it('should return JWT config from auth info fields', () => {
      const config = devHub.getJwtConfig();

      expect(config).toEqual({
        clientId: 'test-client-id',
        loginUrl: 'https://login.salesforce.com',
        privateKeyPath: '/path/to/key.pem',
      });
    });

    it('should default to empty strings when fields are missing', () => {
      conn.getAuthInfoFields.mockReturnValue({});

      const config = devHub.getJwtConfig();

      expect(config.clientId).toBe('');
      expect(config.privateKeyPath).toBe('');
    });
  });

  // --------------------------------------------------------------------------
  // getUserEmail
  // --------------------------------------------------------------------------

  describe('getUserEmail', () => {
    it('should query User email by username', async () => {
      conn.query.mockResolvedValue({
        records: [{Email: 'user@example.com'}],
      });

      const email = await devHub.getUserEmail('test@scratch.org');

      expect(conn.query).toHaveBeenCalledWith(expect.stringContaining("Username = 'test@scratch.org'"));
      expect(email).toBe('user@example.com');
    });

    it('should throw OrgError when user not found', async () => {
      conn.query.mockResolvedValue({records: []});

      await expect(devHub.getUserEmail('missing@scratch.org')).rejects.toThrow(OrgError);
    });
  });

  // --------------------------------------------------------------------------
  // sendEmail
  // --------------------------------------------------------------------------

  describe('sendEmail', () => {
    it('should call the emailSimple action endpoint', async () => {
      conn.request.mockResolvedValue({});

      await devHub.sendEmail({
        body: 'Email body text',
        subject: 'Test Subject',
        to: 'recipient@example.com',
      });

      expect(conn.request).toHaveBeenCalledWith({
        body: expect.stringContaining('"emailSubject":"Test Subject"'),
        method: 'POST',
        url: '/services/data/v62.0/actions/standard/emailSimple',
      });
    });
  });

  // --------------------------------------------------------------------------
  // shareOrg
  // --------------------------------------------------------------------------

  describe('shareOrg', () => {
    it('should compose and send an email with org credentials', async () => {
      conn.request.mockResolvedValue({});

      const org = {
        auth: {
          loginUrl: 'https://test.salesforce.com',
          password: 'pw-123',
          username: 'test@scratch.org',
        },
        orgId: '00D000000000001',
        orgType: 'scratch' as const,
      };

      await devHub.shareOrg(org, {emailAddress: 'recipient@example.com'});

      expect(conn.request).toHaveBeenCalledWith(
        expect.objectContaining({
          body: expect.stringContaining('test@scratch.org'),
          method: 'POST',
        }),
      );
    });

    it('should emit org:share:complete event on success', async () => {
      conn.request.mockResolvedValue({});

      const org = {
        auth: {loginUrl: 'https://test.salesforce.com', password: 'pw-123', username: 'test@scratch.org'},
        orgId: '00D000000000001',
        orgType: 'scratch' as const,
      };

      const listener = vi.fn();
      devHub.on('org:share:complete', listener);

      await devHub.shareOrg(org, {emailAddress: 'user@example.com'});

      expect(listener).toHaveBeenCalledWith(
        expect.objectContaining({
          emailAddress: 'user@example.com',
          username: 'test@scratch.org',
        }),
      );
    });

    it('should throw OrgError when email fails', async () => {
      conn.request.mockRejectedValue(new Error('SMTP failure'));

      const org = {
        auth: {loginUrl: 'https://test.salesforce.com', password: 'pw-123', username: 'test@scratch.org'},
        orgId: '00D000000000001',
        orgType: 'scratch' as const,
      };

      await expect(
        devHub.shareOrg(org, {emailAddress: 'user@example.com'}),
      ).rejects.toThrow(OrgError);
    });
  });
});
