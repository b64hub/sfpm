import {AuthInfo, Org} from '@salesforce/core';

import type {PoolOrgAuthenticator} from '../../pool/types.js';
import type {PoolOrg} from '../pool-org.js';
import type {JwtAuthConfig} from '../types.js';

// ============================================================================
// AuthService
// ============================================================================

/**
 * Default authenticator for pool-managed orgs.
 *
 * Supports two authentication mechanisms, tried in order:
 *
 * 1. **Auth URL** (default) — If the org has an `auth.authUrl` (stored
 *    as `Auth_Url__c` on the hub record — `ScratchOrgInfo` for scratch
 *    orgs, `Sandbox_Pool_Org__c` for sandboxes), `AuthInfo.create({ authUrl })`
 *    is used. This works for both scratch orgs and sandboxes, and is the
 *    recommended approach in CI/CD where the creating user and the
 *    claiming user are different.
 *
 * 2. **JWT fallback** — If no auth URL is present and JWT config is
 *    provided, falls back to `parentUsername`-based JWT authentication
 *    (the legacy scratch org approach).
 *
 * If neither method is available, `login()` throws and `hasValidAuth()`
 * returns `false`.
 *
 * @example
 * ```typescript
 * // Auth URL only (sandboxes, or scratch orgs with Auth_Url__c)
 * const auth = new AuthService(hubUsername);
 *
 * // Auth URL with JWT fallback (scratch orgs)
 * const auth = new AuthService(hubUsername, jwtConfig);
 *
 * const fetcher = new PoolFetcher(strategy, auth, logger);
 * ```
 */
export default class AuthService implements PoolOrgAuthenticator {
  private readonly hubUsername: string;
  private readonly jwtConfig?: JwtAuthConfig;

  constructor(hubUsername: string, jwtConfig?: JwtAuthConfig) {
    this.hubUsername = hubUsername;
    this.jwtConfig = jwtConfig;
  }

  async enableSourceTracking(org: PoolOrg): Promise<void> {
    if (!org.auth.username) return;

    const authInfo = await AuthInfo.create({username: org.auth.username});
    authInfo.update({tracksSource: true});
    await authInfo.save();
  }

  hasValidAuth(org: PoolOrg): boolean {
    // Auth URL is the strongest signal
    if (org.auth.authUrl) return true;

    // JWT fallback requires username + loginUrl + JWT config
    if (org.auth.username && org.auth.loginUrl && this.jwtConfig?.clientId) {
      return true;
    }

    return false;
  }

  /**
   * Authenticate to a pool org.
   *
   * Tries auth URL first (org-type agnostic). If unavailable, falls
   * back to JWT via `parentUsername` (scratch orgs only).
   *
   * @throws {Error} When neither auth URL nor JWT config is available
   */
  async login(org: PoolOrg): Promise<void> {
    if (!org.auth.username) {
      throw new Error('Login error: org must have a valid username');
    }

    // 1. Auth URL (preferred — works for both scratch orgs and sandboxes)
    if (org.auth.authUrl) {
      try {
        const authInfo = await AuthInfo.create({
          authUrl: org.auth.authUrl,
          username: org.auth.username,
        });
        await authInfo.save();
        await Org.create({aliasOrUsername: org.auth.username});
        return;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`Auth URL login failed for ${org.auth.username}: ${message}`);
      }
    }

    // 2. JWT fallback (scratch orgs with parentUsername)
    if (this.jwtConfig?.clientId) {
      try {
        const authInfo = await AuthInfo.create({
          oauth2Options: {
            clientId: this.jwtConfig.clientId,
            loginUrl: this.jwtConfig.loginUrl ?? 'https://login.salesforce.com',
            privateKeyFile: this.jwtConfig.privateKeyPath,
          },
          parentUsername: this.hubUsername,
          username: org.auth.username,
        });
        await authInfo.save();
        await Org.create({aliasOrUsername: org.auth.username});
        return;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`JWT login failed for ${org.auth.username}: ${message}`);
      }
    }

    throw new Error(`No authentication method available for ${org.auth.username}. `
      + 'Provide an auth URL (Auth_Url__c) on the hub record or configure JWT.');
  }
}
