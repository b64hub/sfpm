import type {ScratchOrg} from './scratch/types.js';

// ============================================================================
// Authentication
// ============================================================================

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

// ============================================================================
// Hub Org Abstraction
// ============================================================================

/**
 * Abstraction over a Salesforce DevHub.
 *
 * Decouples org-service from @salesforce/core so the orgs package
 * depends only on sfpm-core types. The concrete implementation
 * (`DevHubService`) bridges this interface to the real Salesforce SDK.
 */
export interface DevHub {
  /** Create a scratch org against this DevHub */
  createScratchOrg(request: ScratchOrgCreateRequest): Promise<ScratchOrgCreateResult>;

  /** Delete active scratch org records by their IDs */
  deleteActiveScratchOrgs(recordIds: string[]): Promise<void>;

  /** Generate and set a password for a scratch org user */
  generatePassword(username: string): Promise<PasswordResult>;

  /**
   * Retrieve JWT auth configuration for the hub.
   *
   * Returns the `clientId` and `privateKeyPath` used to authenticate.
   * Scratch orgs inherit the DevHub's Connected App credentials
   * automatically via the `parentUsername` mechanism.
   */
  getJwtConfig(): JwtAuthConfig;

  /**
   * Find active scratch orgs that have no pool tag.
   *
   * Queries `ScratchOrgInfo WHERE Pooltag__c = null AND Status = 'Active'`.
   * Useful for cleanup operations to identify orgs that were created
   * outside of the pool lifecycle or whose tag was cleared.
   */
  getOrphanedScratchOrgs(): Promise<ScratchOrg[]>;

  /**
   * Look up a ScratchOrgInfo record ID by its SignupUsername.
   *
   * Uses the DevHub's `ScratchOrgInfo` sobject to find the record
   * matching the given username. Returns the record ID or `undefined`
   * if no match is found.
   */
  getScratchOrgInfoByUsername(username: string): Promise<string | undefined>;

  /**
   * Get scratch org usage counts grouped by user email.
   *
   * Queries `ActiveScratchOrg` and groups by `SignupEmail`, returning
   * the count per user ordered by usage descending. Useful for
   * reporting and capacity planning.
   */
  getScratchOrgUsageByUser(): Promise<ScratchOrgUsage[]>;

  /**
   * Look up a user's email address by their username.
   *
   * Queries the `User` SObject in the DevHub. Retries up to 3 times
   * to handle transient API failures.
   */
  getUserEmail(username: string): Promise<string>;

  /** Returns the hub org username */
  getUsername(): string;

  /** Send a simple email via the connected org's REST API */
  sendEmail(options: SendEmailOptions): Promise<void>;

  /** Set a local alias for a username */
  setAlias(username: string, alias: string): Promise<void>;

  /**
   * Set a password for a user via the DevHub.
   *
   * Looks up the user by username and assigns the given password.
   * Use this in combination with `generatePassword()` utility when you
   * need explicit control over password generation vs assignment.
   *
   * @param username - The username of the org/user to set password for
   * @param password - The password to assign
   */
  setUserPassword(username: string, password: string): Promise<void>;

  /**
   * Update fields on a ScratchOrgInfo record.
   *
   * Wraps `connection.sobject('ScratchOrgInfo').update()`. The `id` field
   * is required to identify the record; all other fields are merged.
   *
   * @param fields - Object with `Id` and any ScratchOrgInfo fields to update
   * @returns `true` if the update succeeded
   */
  updateScratchOrgInfo(fields: Record<string, unknown> & {Id: string}): Promise<boolean>;
}

// ============================================================================
// Scratch Org Types
// ============================================================================

/**
 * Configuration for creating a scratch org.
 */
export interface ScratchOrgCreateRequest {
  /** Path to the scratch org definition file */
  definitionFile: string;
  /** Number of days until the org expires */
  durationDays: number;
  /** Whether to exclude ancestor versions */
  noAncestors?: boolean;
  /** Whether to exclude namespace from the org */
  noNamespace?: boolean;
  /** Number of retries on transient failures */
  retries?: number;
  /** Max minutes to wait for org creation */
  waitMinutes?: number;
}

/**
 * Result returned from the hub after scratch org creation.
 */
export interface ScratchOrgCreateResult {
  loginUrl: string;
  orgId: string;
  username: string;
  warnings?: string[];
}

/**
 * Result from password generation.
 */
export interface PasswordResult {
  password: string | undefined;
}

/**
 * Options for sending an email through the org's REST API.
 */
export interface SendEmailOptions {
  body: string;
  subject: string;
  to: string;
}

/**
 * Scratch org usage count for a single user.
 *
 * Returned by `DevHub.getScratchOrgUsageByUser()`. Maps to
 * the `SELECT count(id) In_Use, SignupEmail FROM ActiveScratchOrg
 * GROUP BY SignupEmail` aggregate query.
 */
export interface ScratchOrgUsage {
  /** Number of active scratch orgs owned by this user */
  count: number;
  /** The user's signup email address */
  email: string;
}

/**
 * Scratch org creation defaults used when provisioning orgs for a pool.
 *
 * These settings control how individual scratch orgs are created.
 * They can be overridden per-invocation via `CreateScratchOrgOptions`.
 */
export interface ScratchOrgDefaults {
  /** Path to the scratch org definition file (e.g., `config/project-scratch-def.json`) */
  definitionFile: string;
  /** Number of days until scratch orgs expire (default: 7) */
  expiryDays?: number;
  /** Max retries on transient creation failures (default: 3) */
  maxRetries?: number;
  /** Whether to exclude ancestor package versions (default: false) */
  noAncestors?: boolean;
  /** Max minutes to wait for org creation (default: 6) */
  waitMinutes?: number;
}

/** Default scratch org creation settings. */
export const DEFAULT_SCRATCH_ORG: Required<Pick<ScratchOrgDefaults, 'expiryDays' | 'maxRetries' | 'noAncestors' | 'waitMinutes'>> = {
  expiryDays: 7,
  maxRetries: 3,
  noAncestors: false,
  waitMinutes: 6,
};

// ============================================================================
// OrgService Options
// ============================================================================

/**
 * Allocation status values for scratch orgs managed by a pool.
 *
 * Mirrors the picklist on the DevHub's `ScratchOrgInfo.Allocation_Status__c`.
 */
export type AllocationStatus = 'Allocate' | 'Assigned' | 'Available' | 'In Progress' | 'Return';

/**
 * Options for creating a scratch org through OrgService.
 */
export interface CreateScratchOrgOptions {
  /** Local alias for the scratch org */
  alias: string;
  /** Path to the scratch org definition file */
  definitionFile: string;
  /** Number of days until the org expires (default: 7) */
  expiryDays?: number;
  /** Whether to exclude ancestor versions */
  noAncestors?: boolean;
  /** Max minutes to wait for org creation (default: 6) */
  waitMinutes?: number;
}

/**
 * Options for sharing a scratch org via email.
 */
export interface ShareScratchOrgOptions {
  /** Email address to send the org details to */
  emailAddress: string;
}

// ============================================================================
// OrgService Events
// ============================================================================

/**
 * Event map for OrgService. Used with EventEmitter for
 * type-safe event handling.
 */
export interface OrgServiceEvents {
  'scratch:create:complete': [payload: {alias: string; elapsedMs: number; orgId: string; timestamp: Date; username: string}];
  'scratch:create:error': [payload: {alias: string; error: string; timestamp: Date}];
  'scratch:create:start': [payload: {alias: string; definitionFile: string; timestamp: Date}];
  'scratch:delete:complete': [payload: {orgIds: string[]; timestamp: Date}];
  'scratch:delete:start': [payload: {orgIds: string[]; timestamp: Date}];
  'scratch:share:complete': [payload: {emailAddress: string; timestamp: Date; username: string}];
  'scratch:status:complete': [payload: {status: AllocationStatus; timestamp: Date; username: string}];
}

// ============================================================================
// Errors
// ============================================================================

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
