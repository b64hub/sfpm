import { PoolOrg } from '../index.js';

export {DEFAULT_SCRATCH_ORG, type ScratchOrgDefaults} from './scratch/types.js';
export type {
  ScratchOrgCreateOptions as CreateScratchOrgOptions, ScratchOrgCreateRequest, ScratchOrgCreateResult
} from './scratch/types.js';

/**
 * JWT bearer flow configuration.
 *
 * Mirrors the fields required by `@salesforce/core` `AuthInfo.create()`
 * when `privateKey` is present. The Connected App must have a digital
 * certificate uploaded that pairs with the private key.
 *
 * For scratch orgs created from a JWT-authenticated DevHub, the library
 * automatically inherits the `clientId` and `privateKey` via the
 * `parentUsername` mechanism — so you typically only configure this
 * once for the DevHub.
 *
 * @example
 * ```typescript
 * const jwtConfig: JwtAuthConfig = {
 *   clientId: 'CONNECTED_APP_CONSUMER_KEY',
 *   loginUrl: 'https://login.salesforce.com',
 *   privateKeyPath: '/path/to/server.key',
 * };
 * ```
 */
export interface JwtAuthConfig {
  /** Connected App consumer key (client ID) */
  clientId: string;
  /** Login URL for the org (default: https://login.salesforce.com) */
  loginUrl?: string;
  /** Absolute path to the PEM-encoded RSA private key file */
  privateKeyPath: string;
}


export interface DevHub {
  /**
   * Retrieve JWT auth configuration for the hub.
   *
   * Returns the `clientId` and `privateKeyPath` used to authenticate.
   * Scratch orgs inherit the Connected App credentials automatically
   * via the `parentUsername` mechanism.
   */
  getJwtConfig(): JwtAuthConfig;
  getUserEmail(username: string): Promise<string>;
  shareOrg(org: PoolOrg, options: ShareOrgOptions): Promise<void>;
}


export interface PasswordResult {
  password: string | undefined;
}


/**
 * Allocation status values for scratch orgs managed by a pool.
 *
 * Mirrors the picklist on the DevHub's `ScratchOrgInfo.Allocation_Status__c`.
 */
export enum AllocationStatus {
  Allocated = 'Allocated',
  Assigned = 'Assigned',
  Available = 'Available',
  InProgress = 'In Progress',
  Return = 'Return',
}

/**
 * Options for sharing org credentials via email.
 */
export interface ShareOrgOptions {
  emailAddress: string;
}

/**
 * Event map for `DevHubService`. Used with `EventEmitter` for
 * type-safe event handling.
 */
export interface DevHubEvents {
  'org:share:complete': [payload: {emailAddress: string; timestamp: Date; username: string}];
}


/**
 * Error that occurs during org operations (create, delete, share, etc.).
 *
 * Follows the SFPM error pattern: structured context, display formatting,
 * and error chain preservation.
 */
export class OrgError extends Error {
  public readonly context: Record<string, unknown>;
  public readonly operation: 'auth' | 'create' | 'delete' | 'fetch' | 'password' | 'prerequisite' | 'share' | 'update';
  public readonly orgIdentifier?: string;
  public readonly timestamp: Date;

  constructor(
    operation: OrgError['operation'],
    message: string,
    options?: {
      cause?: Error;
      context?: Record<string, unknown>;
      orgIdentifier?: string;
    },
  ) {
    super(message);
    this.name = 'OrgError';
    this.timestamp = new Date();
    this.operation = operation;
    this.orgIdentifier = options?.orgIdentifier;
    this.context = options?.context ?? {};

    if (options?.cause) {
      this.cause = options.cause;
      if (options.cause.stack) {
        this.stack = `${this.stack}\nCaused by: ${options.cause.stack}`;
      }
    }

    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, OrgError);
    }
  }

  public toDisplayMessage(): string {
    const parts: string[] = [`Org ${this.operation} failed`];

    if (this.orgIdentifier) {
      parts.push(`Org: ${this.orgIdentifier}`);
    }

    parts.push(`Error: ${this.message}`);

    if (this.cause instanceof Error) {
      parts.push(`Cause: ${this.cause.message}`);
    }

    return parts.join('\n');
  }

  public toJSON(): Record<string, unknown> {
    return {
      cause: this.cause instanceof Error
        ? {message: this.cause.message, name: this.cause.name}
        : undefined,
      context: this.context,
      message: this.message,
      operation: this.operation,
      orgIdentifier: this.orgIdentifier,
      timestamp: this.timestamp.toISOString(),
      type: this.name,
    };
  }
}
