import type {Logger} from '@b64/sfpm-core';

import {escapeSOQL, soql} from '@b64/sfpm-core';
import {type Org} from '@salesforce/core';
import {group} from 'node:console';
import {EventEmitter} from 'node:events';

import type {PoolOrg} from '../pool-org.js';
import type {
  DevHub, DevHubEvents, JwtAuthConfig, ShareOrgOptions,
} from '../types.js';

import {OrgError} from '../types.js';

/**
 * Options for sending an email through the hub org's REST API.
 */
export interface SendEmailOptions {
  body: string;
  subject: string;
  to: string;
}

/**
 * Service that wraps a Salesforce DevHub / Production org.
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
export default class DevHubService extends EventEmitter<DevHubEvents> implements DevHub {
  private readonly conn;
  private readonly hubOrg: Org;
  private readonly logger?: Logger;

  constructor(hubOrg: Org, logger?: Logger) {
    super();
    this.hubOrg = hubOrg;
    this.conn = hubOrg.getConnection();
    this.logger = logger;
  }

  public getJwtConfig(): JwtAuthConfig {
    const authInfo = this.conn.getAuthInfoFields();
    return {
      clientId: authInfo.clientId ?? '',
      loginUrl: authInfo.loginUrl,
      privateKeyPath: authInfo.privateKey ?? '',
    };
  }

  public async getUserEmail(username: string): Promise<string> {
    const query = soql`SELECT Email FROM User WHERE Username = '${escapeSOQL(username)}'`;
    const result = await this.conn.query<{Email: string}>(query);

    if (result.records.length === 0) {
      throw new OrgError('fetch', `No user found with username ${username} in the hub org.`);
    }

    return result.records[0].Email;
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

  /**
   * Share org credentials with a user via email.
   *
   * Composes a notification email with the org's login URL, username,
   * and password, then sends it through the hub org's REST API.
   *
   * @throws {OrgError} When the email fails to send
   */
  public async shareOrg(org: PoolOrg, options: ShareOrgOptions): Promise<void> {
    const {emailAddress} = options;

    const username: string = this.hubOrg.getUsername()!;

    const body = [
      `${username} has fetched a new org from the pool!`,
      '',
      'All post-provisioning scripts have been successfully completed in this org!',
      '',
      `Login URL: ${org.auth.loginUrl}`,
      `Username: ${org.auth.username}`,
      `Password: ${org.auth.password}`,
      '',
      `Use: sf org login web --instance-url ${org.auth.loginUrl} --alias <alias>`,
    ].join('\n');

    try {
      await this.sendEmail({
        body,
        subject: `${username} created you a new Salesforce org`,
        to: emailAddress,
      });

      this.logger?.info(`Email sent to ${emailAddress} for ${org.auth.username}`);

      this.emit('org:share:complete', {
        emailAddress,
        timestamp: new Date(),
        username: org.auth.username,
      });
    } catch (error) {
      throw new OrgError('share', `Failed to send org details to ${emailAddress}`, {
        cause: error instanceof Error ? error : new Error(String(error)),
        orgIdentifier: org.auth.username,
      });
    }
  }
}
