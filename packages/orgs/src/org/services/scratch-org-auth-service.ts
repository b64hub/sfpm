import {AuthInfo, Org} from '@salesforce/core';

import type {JwtAuthConfig, PoolOrgAuthenticator} from '../../types.js';
import type {ScratchOrg} from '../scratch/types.js';

// ============================================================================
// ScratchOrgAuthService
// ============================================================================

/**
 * Service for JWT-based scratch org authentication.
 *
 * Handles the local auth setup for scratch orgs fetched from a pool.
 * Scratch orgs inherit the DevHub's Connected App credentials via the
 * `parentUsername` mechanism — the service calls `AuthInfo.create()`
 * with `parentUsername` and JWT `oauth2Options` to establish a local
 * auth session.
 *
 * @example
 * ```ts
 * import { DevHubService, ScratchOrgAuthService } from '@b64/sfpm-orgs';
 *
 * const devHub = new DevHubService(org);
 * const auth = new ScratchOrgAuthService(
 *   devHub.getUsername(),
 *   devHub.getJwtConfig(),
 * );
 *
 * const fetcher = new PoolFetcher({
 *   authenticator: auth,
 *   orgService,
 *   poolOrgSource: devHub,
 * });
 * ```
 */
export default class ScratchOrgAuthService implements PoolOrgAuthenticator {
  private readonly hubUsername: string;
  private readonly jwtConfig: JwtAuthConfig;

  constructor(hubUsername: string, jwtConfig: JwtAuthConfig) {
    this.hubUsername = hubUsername;
    this.jwtConfig = jwtConfig;
  }

  async enableSourceTracking(scratchOrg: ScratchOrg): Promise<void> {
    if (!scratchOrg.username) return;

    const authInfo = await AuthInfo.create({username: scratchOrg.username});
    authInfo.update({tracksSource: true});
    await authInfo.save();
  }

  hasValidAuth(scratchOrg: ScratchOrg): boolean {
    return Boolean(scratchOrg.username && scratchOrg.loginURL);
  }

  async login(scratchOrg: ScratchOrg): Promise<boolean> {
    if (!scratchOrg.username) return false;

    try {
      const authInfo = await AuthInfo.create({
        oauth2Options: {
          clientId: this.jwtConfig.clientId,
          loginUrl: this.jwtConfig.loginUrl ?? 'https://login.salesforce.com',
          privateKeyFile: this.jwtConfig.privateKeyPath,
        },
        parentUsername: this.hubUsername,
        username: scratchOrg.username,
      });

      await authInfo.save();

      // Verify the connection works by creating an Org instance
      await Org.create({aliasOrUsername: scratchOrg.username});

      return true;
    } catch {
      return false;
    }
  }
}
