import {escapeSOQL, soql} from '@b64/sfpm-core';
import type {Org} from '@salesforce/core';

import type {DevHub, JwtAuthConfig, SendEmailOptions} from '../types.js';
import {OrgError} from '../types.js';

// ============================================================================
// DevHubService — Hub-level operations only
// ============================================================================

/**
 * Service that wraps a Salesforce hub `Org` for hub-level operations.
 *
 * Covers authentication config, user lookups, and email — everything
 * that belongs to the hub itself rather than to any specific pool org
 * type. All SObject-level pool operations (queries, claims, metadata)
 * live on the `OrgProvider` facets (`ScratchOrgProvider`, `SandboxProvider`).
 *
 * Uses composition — holds a reference to the `Org` connection and
 * delegates to `@salesforce/core` APIs.
 *
 * @example
 * ```ts
 * import { Org } from '@salesforce/core';
 * import { DevHubService } from '@b64/sfpm-orgs';
 *
 * const org = await Org.create({ aliasOrUsername: 'my-devhub' });
 * const hub = new DevHubService(org);
 *
 * const jwtConfig = hub.getJwtConfig();
 * const email = await hub.getUserEmail('user@example.com');
 * ```
 */
export default class DevHubService implements DevHub {
  private readonly conn;
  private readonly hubUsername: string;

  constructor(hubOrg: Org) {
    this.conn = hubOrg.getConnection();
    this.hubUsername = hubOrg.getUsername() ?? '';
  }

  // ==========================================================================
  // HubService
  // ==========================================================================

  getJwtConfig(): JwtAuthConfig {
    const fields = this.conn.getAuthInfoFields();
    return {
      clientId: fields.clientId ?? '',
      loginUrl: fields.loginUrl,
      privateKeyPath: fields.privateKey ?? '',
    };
  }

  async getUserEmail(username: string): Promise<string> {
    const query = soql`SELECT Email FROM User WHERE Username = '${escapeSOQL(username)}'`;
    const result = await this.conn.query<{Email: string}>(query);

    if (result.records.length === 0) {
      throw new OrgError('fetch', `No user found with username ${username} in the hub org.`);
    }

    return result.records[0].Email;
  }

  getUsername(): string {
    return this.hubUsername;
  }

  async sendEmail(options: SendEmailOptions): Promise<void> {
    const apiVersion = this.conn.getApiVersion();
    await this.conn.request({
      body: JSON.stringify({
        inputs: [
          {
            emailAddresses: options.to,
            emailBody: options.body,
            emailSubject: options.subject,
          },
        ],
      }),
      method: 'POST',
      url: `/services/data/v${apiVersion}/actions/standard/emailSimple`,
    });
  }
}
