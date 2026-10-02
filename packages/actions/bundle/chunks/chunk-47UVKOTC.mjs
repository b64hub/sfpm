import {createRequire as ___createRequire} from 'node:module';
import {fileURLToPath as ___fileURLToPath} from 'node:url';
import {dirname as ___dirname_fn} from 'node:path';
const require = ___createRequire(import.meta.url);
const __filename = ___fileURLToPath(import.meta.url);
const __dirname = ___dirname_fn(__filename);
process.env.SF_DISABLE_LOG_FILE ??= 'true';
import {
  ArtifactProvider,
  InstallOrchestrator,
  PackageInstaller,
  PackageService,
  ProjectService,
  TypedEventEmitter,
  WorkspaceProvider,
  __toESM,
  escapeSOQL,
  require_lib2 as require_lib,
  require_lib3 as require_lib2,
  soql
} from "./chunk-YY7I435Q.mjs";

// ../orgs/dist/pool/pool-factory.js
var import_core10 = __toESM(require_lib(), 1);

// ../orgs/dist/org/sandbox/sandbox-provider.js
var import_core9 = __toESM(require_lib(), 1);
var import_kit2 = __toESM(require_lib2(), 1);
import { readFile } from "node:fs/promises";

// ../orgs/dist/org/pool-org.js
var import_core = __toESM(require_lib(), 1);
function buildPoolAlias(tag, isSandboxPool, index) {
  return isSandboxPool ? `${tag.toUpperCase().replaceAll("-", "")}${index}` : `${tag}-${index}`;
}
function isSandbox(org) {
  return org.orgType === import_core.OrgTypes.Sandbox;
}

// ../orgs/dist/org/sandbox/types.js
var DEFAULT_SANDBOX = {
  maxRetries: 3,
  waitMinutes: 30
};

// ../orgs/dist/org/scratch/scratch-org-provider.js
var import_core4 = __toESM(require_lib(), 1);
var import_kit = __toESM(require_lib2(), 1);

// ../orgs/dist/utils/password-generator.js
var import_core2 = __toESM(require_lib(), 1);
async function generatePassword(conditions) {
  const passwordBuffer = import_core2.User.generatePasswordUtf8(conditions);
  return new Promise((resolve) => {
    passwordBuffer.value((buffer) => {
      resolve(buffer.toString("utf8"));
    });
  });
}

// ../orgs/dist/utils/set-alias.js
var import_core3 = __toESM(require_lib(), 1);
async function setAlias(username, alias) {
  const stateAggregator = await import_core3.StateAggregator.getInstance();
  await stateAggregator.aliases.setAndSave(alias, username);
}

// ../orgs/dist/org/scratch/types.js
var DEFAULT_SCRATCH_ORG = {
  expiryDays: 7,
  maxRetries: 3,
  noAncestors: false,
  waitMinutes: 6
};

// ../orgs/dist/org/types.js
var PoolStage;
(function(PoolStage2) {
  PoolStage2["Assigned"] = "Assigned";
  PoolStage2["Available"] = "Available";
  PoolStage2["InProgress"] = "InProgress";
})(PoolStage || (PoolStage = {}));
var OrgError = class _OrgError extends Error {
  context;
  operation;
  orgIdentifier;
  timestamp;
  constructor(operation, message, options) {
    super(message);
    this.name = "OrgError";
    this.timestamp = /* @__PURE__ */ new Date();
    this.operation = operation;
    this.orgIdentifier = options?.orgIdentifier;
    this.context = options?.context ?? {};
    if (options?.cause) {
      this.cause = options.cause;
      if (options.cause.stack) {
        this.stack = `${this.stack}
Caused by: ${options.cause.stack}`;
      }
    }
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, _OrgError);
    }
  }
  toDisplayMessage() {
    const parts = [`Org ${this.operation} failed`];
    if (this.orgIdentifier) {
      parts.push(`Org: ${this.orgIdentifier}`);
    }
    parts.push(`Error: ${this.message}`);
    if (this.cause instanceof Error) {
      parts.push(`Cause: ${this.cause.message}`);
    }
    return parts.join("\n");
  }
  toJSON() {
    return {
      cause: this.cause instanceof Error ? { message: this.cause.message, name: this.cause.name } : void 0,
      context: this.context,
      message: this.message,
      operation: this.operation,
      orgIdentifier: this.orgIdentifier,
      timestamp: this.timestamp.toISOString(),
      type: this.name
    };
  }
};

// ../orgs/dist/org/scratch/scratch-org-provider.js
var SCRATCH_ORG_INFO_FIELDS = [
  "CreatedDate",
  "ExpirationDate",
  "Id",
  "LoginUrl",
  "Tag__c",
  "Stage__c",
  "ScratchOrg",
  "Auth_Url__c",
  "AuthCode",
  "SignupEmail",
  "SignupUsername"
];
var REQUIRED_STAGES = [
  PoolStage.Available,
  PoolStage.InProgress,
  PoolStage.Assigned
];
function to15CharId(id) {
  return id.slice(0, 15);
}
var ScratchOrgProvider = class {
  conn;
  hubOrg;
  constructor(hubOrg) {
    if (!hubOrg.isDevHubOrg) {
      throw new Error("Provided org must be a devhub org");
    }
    this.conn = hubOrg.getConnection();
    this.hubOrg = hubOrg;
  }
  async claimOrg(id) {
    try {
      const result = await this.conn.sobject("ScratchOrgInfo").update({
        Id: id,
        Stage__c: "Assigned"
        // eslint-disable-line camelcase -- Salesforce custom field
      });
      return result.success === true;
    } catch {
      return false;
    }
  }
  async cleanupOrgs(orgs) {
    const usernames = orgs.map((o) => o.auth.username).filter(Boolean);
    if (usernames.length === 0)
      return;
    try {
      await Promise.all(usernames.map(async (username) => {
        const scratchOrg = await import_core4.Org.create({ aliasOrUsername: username });
        await scratchOrg.deleteFrom(this.hubOrg);
      }));
    } catch {
    }
  }
  async createOrg(options) {
    const result = await this.createScratchOrg({
      ...options,
      durationDays: options.durationDays ?? DEFAULT_SCRATCH_ORG.expiryDays,
      noancestors: options.noancestors ?? DEFAULT_SCRATCH_ORG.noAncestors,
      nonamespace: options.nonamespace ?? true,
      retry: options.retry ?? DEFAULT_SCRATCH_ORG.maxRetries,
      wait: options.wait ?? import_kit.Duration.minutes(DEFAULT_SCRATCH_ORG.waitMinutes)
    });
    const username = result.username ?? "";
    const orgId = result.authFields?.orgId ?? "";
    if (options.alias) {
      await setAlias(username, options.alias);
    }
    const scratchOrg = {
      auth: {
        alias: options.alias,
        loginUrl: result.authFields?.loginUrl ?? result.authFields?.instanceUrl ?? "",
        username
      },
      orgId,
      orgType: import_core4.OrgTypes.Scratch
    };
    try {
      const authUrl = result.authInfo?.getSfdxAuthUrl();
      if (authUrl) {
        scratchOrg.auth.authUrl = authUrl;
      }
    } catch {
    }
    return scratchOrg;
  }
  async deleteOrgs(recordIds) {
    for (const recordId of recordIds) {
      await this.conn.sobject("ActiveScratchOrg").destroy(recordId);
    }
  }
  async getActiveCountByTag(tag) {
    const query = soql`SELECT count() FROM ScratchOrgInfo WHERE Tag__c = '${escapeSOQL(tag)}' AND Status = 'Active'`;
    const result = await this.conn.query(query);
    return result.totalSize;
  }
  async getAvailableByTag(tag, myPool) {
    const escapedTag = escapeSOQL(tag);
    const conditions = [
      `Tag__c = '${escapedTag}'`,
      "Status = 'Active'",
      `(Stage__c = '${PoolStage.Available}' OR Stage__c = '${PoolStage.InProgress}')`
    ];
    const username = this.hubOrg.getUsername();
    if (myPool) {
      conditions.push(`CreatedById = '${escapeSOQL(username)}'`);
    }
    const query = soql`SELECT ${SCRATCH_ORG_INFO_FIELDS.join(", ")} FROM ScratchOrgInfo WHERE ${conditions.join(" AND ")} ORDER BY CreatedDate DESC`;
    const result = await this.conn.query(query);
    return result.records.map((r) => mapToScratchOrg(r));
  }
  async getOrgsByTag(tag, myPool) {
    const conditions = ["Status = 'Active'"];
    if (tag) {
      conditions.push(`Tag__c = '${escapeSOQL(tag)}'`);
    } else {
      conditions.push("Tag__c != null");
    }
    const username = this.hubOrg.getUsername();
    if (myPool) {
      conditions.push(`CreatedById = '${escapeSOQL(username)}'`);
    }
    const query = soql`SELECT ${SCRATCH_ORG_INFO_FIELDS.join(", ")} FROM ScratchOrgInfo WHERE ${conditions.join(" AND ")} ORDER BY CreatedDate DESC`;
    const result = await this.conn.query(query);
    const orgs = result.records.map((r) => mapToScratchOrg(r));
    if (orgs.length > 0) {
      await this.resolveActiveRecordIds(result.records, orgs);
    }
    return orgs;
  }
  /** Get org usage counts grouped by user email. */
  async getOrgUsageByUser() {
    const query = soql`SELECT count(Id) In_Use, SignupEmail FROM ActiveScratchOrg GROUP BY SignupEmail ORDER BY count(Id) DESC`;
    const result = await this.conn.query(query);
    return result.records.map((r) => ({ count: r.In_Use, email: r.SignupEmail }));
  }
  /** Find active orgs that have no pool tag. */
  async getOrphanedOrgs() {
    const query = soql`SELECT ${SCRATCH_ORG_INFO_FIELDS.join(", ")} FROM ScratchOrgInfo WHERE Tag__c = null AND Stage__c = 'Active' ORDER BY CreatedDate DESC`;
    const result = await this.conn.query(query);
    return result.records.map((r) => mapToScratchOrg(r));
  }
  async getRecordIds(orgs) {
    if (orgs.length === 0)
      return orgs;
    const missingIds = orgs.filter((org) => !org.recordId && org.orgId);
    if (missingIds.length === 0)
      return orgs;
    const orgIdMap = /* @__PURE__ */ new Map();
    for (const org of missingIds) {
      orgIdMap.set(to15CharId(org.orgId), org);
    }
    const idList = [...orgIdMap.keys()].map((id) => `'${escapeSOQL(id)}'`).join(",");
    const query = soql`SELECT Id, ScratchOrg FROM ScratchOrgInfo WHERE ScratchOrg IN (${idList})`;
    const result = await this.conn.query(query);
    for (const record of result.records) {
      if (record.ScratchOrg) {
        const org = orgIdMap.get(to15CharId(record.ScratchOrg));
        if (org) {
          org.recordId = record.Id;
        }
      }
    }
    return orgs;
  }
  async getRemainingCapacity() {
    const apiVersion = this.conn.getApiVersion();
    const limits = await this.conn.request(`/services/data/v${apiVersion}/limits`);
    return limits.ActiveScratchOrgs?.Remaining ?? 0;
  }
  /** Look up a ScratchOrgInfo record ID by username. */
  async getScratchOrgInfoByUsername(username) {
    const query = soql`SELECT Id FROM ScratchOrgInfo WHERE SignupUsername = '${escapeSOQL(username)}'`;
    const result = await this.conn.query(query);
    return result.records[0]?.Id;
  }
  async isOrgActive(username) {
    const query = soql`SELECT Id FROM ActiveScratchOrg WHERE SignupUsername = '${escapeSOQL(username)}'`;
    const result = await this.conn.query(query);
    return result.totalSize > 0;
  }
  async setPassword(username, password) {
    const newPassword = password ?? await generatePassword();
    await this.setUserPassword(username, newPassword);
    return { password: newPassword };
  }
  /** Update fields on a ScratchOrgInfo record. */
  async updateOrgInfo(fields) {
    const result = await this.conn.sobject("ScratchOrgInfo").update(fields);
    return result.success === true;
  }
  async updatePoolMetadata(records) {
    if (records.length === 0)
      return;
    const updates = records.map((r) => ({
      Auth_Url__c: r.authUrl,
      // eslint-disable-line camelcase -- Salesforce custom field
      Id: r.id,
      Stage__c: r.stage,
      // eslint-disable-line camelcase -- Salesforce custom field
      Tag__c: r.poolTag
      // eslint-disable-line camelcase -- Salesforce custom field
    }));
    const results = await this.conn.sobject("ScratchOrgInfo").update(updates);
    const failures = (Array.isArray(results) ? results : [results]).filter((r) => !r.success);
    if (failures.length > 0 && failures.length === updates.length) {
      const errors = failures.flatMap((f) => f.errors?.map((e) => e.message) ?? ["unknown error"]);
      throw new OrgError("update", `Failed to update pool metadata on all ${failures.length} record(s): ${errors.join("; ")}`);
    }
  }
  async validate() {
    const describe = await this.conn.sobject("ScratchOrgInfo").describe();
    const stageField = describe.fields.find((f) => f.name === "Stage__c");
    if (!stageField) {
      throw new OrgError("prerequisite", 'ScratchOrgInfo is missing the "Stage__c" custom field. Deploy the sfpm pool custom fields to your DevHub before running pool operations.');
    }
    const picklistValues = new Set((stageField.picklistValues ?? []).map((v) => v.value));
    const missing = REQUIRED_STAGES.filter((s) => !picklistValues.has(s));
    if (missing.length > 0) {
      throw new OrgError("prerequisite", `Stage__c is missing required picklist values: ${missing.join(", ")}. Update the picklist on ScratchOrgInfo in your DevHub.`, { context: { existing: [...picklistValues], missing } });
    }
    const tagField = describe.fields.find((f) => f.name === "Tag__c");
    if (!tagField) {
      throw new OrgError("prerequisite", 'ScratchOrgInfo is missing the "Tag__c" custom field. Deploy the sfpm pool custom fields to your DevHub before running pool operations.');
    }
    const authUrlField = describe.fields.find((f) => f.name === "Auth_Url__c");
    if (!authUrlField) {
      throw new OrgError("prerequisite", 'ScratchOrgInfo is missing the "Auth_Url__c" custom field. Deploy the sfpm pool custom fields to your DevHub before running pool operations.');
    }
  }
  async createScratchOrg(request) {
    return this.hubOrg.scratchOrgCreate(request);
  }
  async resolveActiveRecordIds(records, orgs) {
    const scratchOrgInfoIds = records.filter((r) => r.Id).map((r) => `'${r.Id}'`).join(",");
    if (!scratchOrgInfoIds)
      return;
    const activeQuery = soql`SELECT Id, ScratchOrgInfoId FROM ActiveScratchOrg WHERE ScratchOrgInfoId IN (${scratchOrgInfoIds})`;
    const activeResult = await this.conn.query(activeQuery);
    const activeIdMap = /* @__PURE__ */ new Map();
    for (const record of activeResult.records) {
      activeIdMap.set(record.ScratchOrgInfoId, record.Id);
    }
    for (const [i, record] of records.entries()) {
      const infoId = record.Id;
      if (infoId && activeIdMap.has(infoId)) {
        const activeId = activeIdMap.get(infoId);
        if (activeId) {
          orgs[i].recordId = activeId;
        }
      }
    }
  }
  /** Set a password for a user via the org's SOAP API. */
  async setUserPassword(username, password) {
    const scratchOrgAuthInfo = await import_core4.AuthInfo.create({ username });
    const scratchOrgConnection = await import_core4.Org.create({
      connection: await import_core4.Connection.create({ authInfo: scratchOrgAuthInfo })
    });
    const query = soql`SELECT Id FROM User WHERE Username = '${escapeSOQL(username)}'`;
    const result = await scratchOrgConnection.getConnection().query(query);
    if (result.records.length === 0) {
      throw new OrgError("password", `No user found with username ${username}`);
    }
    await scratchOrgConnection.getConnection().soap.setPassword(result.records[0].Id, password);
  }
};
function mapToScratchOrg(record) {
  const orgId = record.ScratchOrg ?? "";
  const username = record.SignupUsername ?? "";
  const tag = record.Tag__c ?? "";
  const stage = record.Stage__c ?? PoolStage.Available;
  return {
    auth: {
      authUrl: record.Auth_Url__c,
      email: record.SignupEmail,
      loginUrl: record.LoginUrl,
      username
    },
    expiry: record.ExpirationDate ? parseExpirationDate(record.ExpirationDate) : void 0,
    orgId,
    orgType: import_core4.OrgTypes.Scratch,
    pool: {
      stage,
      tag,
      timestamp: record.CreatedDate ? new Date(record.CreatedDate).getTime() : Date.now()
    },
    recordId: record.Id
  };
}
function parseExpirationDate(dateStr) {
  const date = new Date(dateStr);
  return date.getTime();
}

// ../orgs/dist/org/services/auth-service.js
var import_core5 = __toESM(require_lib(), 1);
var AuthService = class {
  hubUsername;
  jwtConfig;
  constructor(hubUsername, jwtConfig) {
    this.hubUsername = hubUsername;
    this.jwtConfig = jwtConfig;
  }
  async enableSourceTracking(org) {
    if (!org.auth.username)
      return;
    const authInfo = await import_core5.AuthInfo.create({ username: org.auth.username });
    authInfo.update({ tracksSource: true });
    await authInfo.save();
  }
  hasValidAuth(org) {
    if (org.auth.authUrl)
      return true;
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
  async login(org) {
    if (!org.auth.username) {
      throw new Error("Login error: org must have a valid username");
    }
    try {
      await import_core5.AuthInfo.create({ username: org.auth.username });
      await import_core5.Org.create({ aliasOrUsername: org.auth.username });
      return;
    } catch {
    }
    if (org.auth.authUrl) {
      try {
        const authInfo = await import_core5.AuthInfo.create({
          oauth2Options: import_core5.AuthInfo.parseSfdxAuthUrl(org.auth.authUrl),
          username: org.auth.username
        });
        await authInfo.save();
        await import_core5.Org.create({ aliasOrUsername: org.auth.username });
        return;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`Auth URL login failed for ${org.auth.username}: ${message}`);
      }
    }
    if (this.jwtConfig?.clientId) {
      try {
        const authInfo = await import_core5.AuthInfo.create({
          oauth2Options: {
            clientId: this.jwtConfig.clientId,
            loginUrl: this.jwtConfig.loginUrl ?? "https://login.salesforce.com",
            privateKeyFile: this.jwtConfig.privateKeyPath
          },
          parentUsername: this.hubUsername,
          username: org.auth.username
        });
        await authInfo.save();
        await import_core5.Org.create({ aliasOrUsername: org.auth.username });
        return;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`JWT login failed for ${org.auth.username}: ${message}`);
      }
    }
    throw new Error(`No authentication method available for ${org.auth.username}. Provide an auth URL (Auth_Url__c) on the hub record or configure JWT.`);
  }
};

// ../orgs/dist/org/services/devhub-service.js
import { EventEmitter } from "node:events";
var DevHubService = class extends EventEmitter {
  conn;
  hubOrg;
  logger;
  constructor(hubOrg, logger) {
    super();
    this.hubOrg = hubOrg;
    this.conn = hubOrg.getConnection();
    this.logger = logger;
  }
  getJwtConfig() {
    const authInfo = this.conn.getAuthInfoFields();
    return {
      clientId: authInfo.clientId ?? "",
      loginUrl: authInfo.loginUrl,
      privateKeyPath: authInfo.privateKey ?? ""
    };
  }
  async getUserEmail(username) {
    const query = soql`SELECT Email FROM User WHERE Username = '${escapeSOQL(username)}'`;
    const result = await this.conn.query(query);
    if (result.records.length === 0) {
      throw new OrgError("fetch", `No user found with username ${username} in the hub org.`);
    }
    return result.records[0].Email;
  }
  async sendEmail(options) {
    const apiVersion = this.conn.getApiVersion();
    await this.conn.request({
      body: JSON.stringify({
        inputs: [
          {
            emailAddresses: options.to,
            emailBody: options.body,
            emailSubject: options.subject
          }
        ]
      }),
      method: "POST",
      url: `/services/data/v${apiVersion}/actions/standard/emailSimple`
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
  async shareOrg(org, options) {
    const { emailAddress } = options;
    const username = this.hubOrg.getUsername();
    const body = [
      `${username} has fetched a new org from the pool!`,
      "",
      "All post-provisioning scripts have been successfully completed in this org!",
      "",
      `Login URL: ${org.auth.loginUrl}`,
      `Username: ${org.auth.username}`,
      `Password: ${org.auth.password}`,
      "",
      `Use: sf org login web --instance-url ${org.auth.loginUrl} --alias <alias>`
    ].join("\n");
    try {
      await this.sendEmail({
        body,
        subject: `${username} created you a new Salesforce org`,
        to: emailAddress
      });
      this.logger?.info(`Email sent to ${emailAddress} for ${org.auth.username}`);
      this.emit("org:share:complete", {
        emailAddress,
        timestamp: /* @__PURE__ */ new Date(),
        username: org.auth.username
      });
    } catch (error) {
      throw new OrgError("share", `Failed to send org details to ${emailAddress}`, {
        cause: error instanceof Error ? error : new Error(String(error)),
        orgIdentifier: org.auth.username
      });
    }
  }
};

// ../orgs/dist/pool/pool-event-bus.js
var PoolEventBus = class extends TypedEventEmitter {
};

// ../orgs/dist/pool/pool-fetcher-event-bus.js
var PoolFetcherEventBus = class extends TypedEventEmitter {
};

// ../orgs/dist/pool/pool-fetcher.js
var PoolFetcher = class {
  provider;
  logger;
  /** Event bus for progress tracking during fetch/claim operations. */
  bus;
  constructor(provider, logger, eventBus) {
    this.provider = provider;
    this.logger = logger;
    this.bus = eventBus ?? new PoolFetcherEventBus();
  }
  /**
   * Fetch a single scratch org from the pool.
   *
   * Uses optimistic concurrency to claim an available org: iterates
   * through candidates and attempts to mark each as `'Allocate'`.
   * The first successful claim wins. If the org has an auth URL,
   * it is authenticated locally.
   *
   * @throws {OrgError} When no orgs are available or none could be claimed
   */
  async fetch(tag, options) {
    const { myPool, postClaimActions = [] } = options ?? {};
    const available = await this.provider.getAvailableByTag(tag, myPool);
    if (available.length === 0) {
      throw new OrgError("fetch", `No orgs available for pool "${tag}"`, {
        context: { tag }
      });
    }
    this.logger?.info(`Pool "${tag}" has ${available.length} candidate(s)`);
    this.bus.emit("pool:fetch:start", {
      available: available.length,
      tag,
      timestamp: /* @__PURE__ */ new Date()
    });
    for (const org of available) {
      const claimed = await this.provider.claimOrg(org.recordId);
      if (claimed) {
        if (org.pool) {
          org.pool.stage = PoolStage.Assigned;
        }
        this.bus.emit("pool:fetch:claimed", {
          tag,
          timestamp: /* @__PURE__ */ new Date(),
          username: org.auth.username
        });
        this.logger?.info(`Claimed org ${org.auth.username} from pool "${tag}"`);
        for (const action of postClaimActions) {
          await action(org);
        }
        this.bus.emit("pool:fetch:complete", {
          count: 1,
          tag,
          timestamp: /* @__PURE__ */ new Date()
        });
        return org;
      }
      this.bus.emit("pool:fetch:skipped", {
        reason: "Claim failed (already taken by another consumer)",
        timestamp: /* @__PURE__ */ new Date(),
        username: org.auth.username
      });
      this.logger?.trace(`Org ${org.auth.username} claim failed, trying next...`);
    }
    throw new OrgError("fetch", `No org could be claimed from pool "${tag}"`, {
      context: { candidateCount: available.length, tag }
    });
  }
  /**
   * Fetch multiple available orgs from the pool.
   *
   * Unlike `fetch()`, this does NOT claim individual orgs. The caller
   * is responsible for updating allocation status as needed (e.g., when
   * transferring orgs from a snapshot pool to a new pool).
   *
   * Post-claim actions run per-org in parallel. Orgs where any action
   * throws are silently filtered out.
   *
   * @throws {OrgError} When no orgs are available
   */
  async fetchAll(tag, options) {
    const { limit, myPool, postClaimActions = [] } = options ?? {};
    let candidates = await this.provider.getAvailableByTag(tag, myPool);
    if (candidates.length === 0) {
      throw new OrgError("fetch", `No orgs available for pool "${tag}"`, {
        context: { tag }
      });
    }
    this.bus.emit("pool:fetch:start", {
      available: candidates.length,
      tag,
      timestamp: /* @__PURE__ */ new Date()
    });
    if (limit && limit < candidates.length) {
      candidates = candidates.slice(0, limit);
    }
    const orgs = candidates.map((org, i) => ({
      ...org,
      auth: { ...org.auth, alias: buildPoolAlias(tag, isSandbox(org), i + 1) },
      pool: { stage: PoolStage.Available, tag: org.pool?.tag ?? tag, timestamp: org.pool?.timestamp ?? Date.now() }
    }));
    const validOrgs = await this.handlePostClaims(orgs, postClaimActions);
    this.bus.emit("pool:fetch:complete", {
      count: validOrgs.length,
      tag,
      timestamp: /* @__PURE__ */ new Date()
    });
    return validOrgs;
  }
  /**
   * Run the post-claim action pipeline on orgs in parallel.
   *
   * Each org's actions run sequentially (in order), but different orgs
   * are processed concurrently. If any action throws for an org, that
   * org is filtered out of the result. Actions that fail non-fatally
   * should catch internally and log rather than throw.
   */
  async handlePostClaims(orgs, actions) {
    if (actions.length === 0)
      return orgs;
    const results = await Promise.allSettled(orgs.map(async (org) => {
      for (const action of actions) {
        await action(org);
      }
      return org;
    }));
    return results.filter((r) => {
      if (r.status === "rejected") {
        const error = r.reason instanceof Error ? r.reason.message : String(r.reason);
        this.logger?.warn(`Post-claim action failed, filtering org: ${error}`);
        return false;
      }
      return true;
    }).map((r) => r.value);
  }
};

// ../orgs/dist/pool/pool-manager.js
var import_core6 = __toESM(require_lib(), 1);

// ../orgs/dist/pool/types.js
var DEFAULT_POOL_SIZING = {
  batch: 5,
  min: 0
};

// ../orgs/dist/pool/pool-manager.js
function formatCreateError(error) {
  if (error instanceof import_core6.SfError) {
    const hint = error.actions?.length ? ` \u2014 ${error.actions.join(" ")}` : "";
    return `${error.message} [${error.name}]${hint}`;
  }
  return error instanceof Error ? error.message : String(error);
}
var DEFAULT_CONCURRENCY = DEFAULT_POOL_SIZING.batch;
var PoolManager = class {
  /** Event bus for progress tracking during the provisioning lifecycle. */
  bus;
  logger;
  loggerFactory;
  provider;
  tasks;
  constructor(options) {
    this.bus = options.eventBus ?? new PoolEventBus();
    this.loggerFactory = options.loggerFactory;
    this.logger = options.logger;
    this.provider = options.provider;
    this.tasks = options.tasks ?? [];
  }
  /**
   * Compute how many scratch orgs should be allocated for a pool.
   *
   * Factors in the current pool count, DevHub remaining capacity,
   * and the pool's configured max allocation.
   */
  async computeAllocation(tag, config) {
    const [remaining, activeCount] = await Promise.all([
      this.provider.getRemainingCapacity(),
      this.provider.getActiveCountByTag(tag)
    ]);
    const allocation = computeOrgAllocation(remaining, activeCount, config.sizing);
    this.bus.emit("pool:allocation:computed", {
      currentAllocation: activeCount,
      remaining,
      tag,
      toAllocate: allocation.toAllocate
    });
    this.logger?.info(`Pool "${tag}": current=${activeCount}, remaining=${remaining}, toAllocate=${allocation.toAllocate}`);
    return allocation;
  }
  /**
   * Delete scratch orgs from a pool.
   *
   * Queries all orgs matching the pool tag, optionally filtering to
   * only 'InProgress' orgs or orgs owned by the current user. Each
   * matching org with a valid `orgId` is deleted via the provider.
   *
   * @param options - Tag, filter, and ownership options
   * @returns Summary of deleted orgs and any errors
   * @throws {OrgError} When `poolOrgSource` was not provided at construction
   */
  async delete(tag, options) {
    const startTime = Date.now();
    const { inProgressOnly, myPool } = options ?? {};
    this.logger?.info(`Querying pool "${tag}" for orgs to delete...`);
    let orgs = await this.provider.getOrgsByTag(tag, myPool);
    if (inProgressOnly) {
      orgs = orgs.filter((org) => org.pool?.stage === PoolStage.InProgress);
    }
    if (orgs.length === 0) {
      this.logger?.info(`No orgs found in pool "${tag}" matching the specified criteria`);
      return {
        deleted: [],
        elapsedMs: Date.now() - startTime,
        errors: [],
        tag
      };
    }
    this.bus.emit("pool:delete:start", {
      count: orgs.length,
      tag,
      timestamp: /* @__PURE__ */ new Date()
    });
    this.logger?.info(`Deleting ${orgs.length} org(s) from pool "${tag}"...`);
    const deleted = [];
    const errors = [];
    for (const org of orgs) {
      if (!org.recordId) {
        errors.push(`Org ${org.auth.username ?? "unknown"} has no recordId \u2014 skipping`);
        continue;
      }
      try {
        await this.provider.deleteOrgs([org.recordId]);
        deleted.push(org);
        this.bus.emit("pool:org:deleted", {
          timestamp: /* @__PURE__ */ new Date(),
          username: org.auth.username
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        errors.push(`Failed to delete org ${org.auth.username ?? org.recordId}: ${message}`);
        this.logger?.warn(`Failed to delete org ${org.auth.username ?? org.recordId}: ${message}`);
      }
    }
    const elapsedMs = Date.now() - startTime;
    const result = {
      deleted,
      elapsedMs,
      errors,
      tag
    };
    this.bus.emit("pool:delete:complete", result);
    this.logger?.info(`Deleted ${deleted.length} org(s) from pool "${tag}" in ${elapsedMs}ms`);
    return result;
  }
  /**
   * List all orgs in a pool regardless of status.
   *
   * Delegates to the provider's `getOrgsByTag()` query. Optionally
   * filters to orgs created by the current user.
   *
   * @param tag - Pool tag to query
   * @param myPool - When true, only return orgs created by the current user
   * @returns All pool orgs with metadata populated
   */
  async list(tag, myPool) {
    this.logger?.info(`Listing orgs for pool${tag ? ` "${tag}"` : ""}...`);
    return this.provider.getOrgsByTag(tag, myPool);
  }
  /**
   * Provision scratch orgs to fill the pool up to its configured capacity.
   *
   * Flow:
   * 1. Query current pool state and DevHub limits
   * 2. Compute how many orgs to allocate
   * 3. Create orgs concurrently (capped at `batchSize`)
   * 4. Validate created orgs are actually active
   * 5. Register them in the pool with metadata
   *
   * @throws {OrgError} When zero orgs could be provisioned
   */
  async provision(tag, config) {
    const concurrency = config.sizing.batch ?? DEFAULT_CONCURRENCY;
    const startTime = Date.now();
    await this.validatePrerequisites();
    const allocation = await this.computeAllocation(tag, config);
    if (allocation.toAllocate === 0) {
      return this.handleZeroAllocation(tag, config, allocation, startTime);
    }
    this.bus.emit("pool:provision:start", {
      tag,
      timestamp: /* @__PURE__ */ new Date(),
      toAllocate: allocation.toAllocate
    });
    this.logger?.info(`Provisioning ${allocation.toAllocate} scratch org(s) for pool "${tag}"...`);
    const results = await this.createOrgsWithConcurrency(tag, config, allocation.toAllocate, concurrency);
    const succeeded = results.filter((r) => Boolean(r.org)).map((r) => r.org);
    const errors = results.filter((r) => r.error).map((r) => r.error);
    this.logger?.info(`Created ${succeeded.length} of ${allocation.toAllocate} org(s), ${errors.length} failed`);
    if (succeeded.length === 0) {
      throw new OrgError("create", "All scratch org provisioning attempts failed", {
        context: { errors, tag }
      });
    }
    const validOrgs = await this.validateOrgs(succeeded);
    if (validOrgs.length === 0) {
      throw new OrgError("create", "All provisioned orgs were found to be inactive", {
        context: { tag }
      });
    }
    let registeredOrgs;
    try {
      registeredOrgs = await this.registerInPool(validOrgs, tag);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger?.warn(`Failed to register ${validOrgs.length} org(s) in pool "${tag}" \u2014 cleaning up: ${message}`);
      await this.cleanupOrphanedOrgs(validOrgs);
      throw new OrgError("create", `Failed to register provisioned orgs in pool "${tag}": ${message}`, {
        cause: error instanceof Error ? error : void 0,
        context: { tag }
      });
    }
    const orphanedOrgs = validOrgs.filter((org) => !org.recordId);
    if (orphanedOrgs.length > 0) {
      this.logger?.warn(`${orphanedOrgs.length} org(s) created but not registered \u2014 cleaning up`);
      await this.cleanupOrphanedOrgs(orphanedOrgs);
    }
    let taskResults;
    if (this.tasks.length > 0) {
      taskResults = await this.runTasksOnOrgs(registeredOrgs);
    }
    const availableOrgs = await this.markOrgsAvailable(registeredOrgs, tag, taskResults);
    if (taskResults) {
      const failedOrgs = registeredOrgs.filter((org) => !availableOrgs.includes(org) && org.recordId);
      if (failedOrgs.length > 0) {
        await this.cleanupFailedOrgs(failedOrgs, tag);
      }
    }
    const elapsedMs = Date.now() - startTime;
    const result = {
      elapsedMs,
      errors,
      failed: allocation.toAllocate - availableOrgs.length,
      succeeded: availableOrgs,
      tag,
      taskResults
    };
    this.bus.emit("pool:provision:complete", result);
    return result;
  }
  /**
   * Validate that the DevHub meets pool operation prerequisites.
   *
   * Checks that the DevHub has the required custom fields and picklist
   * values on `ScratchOrgInfo` for pool operations. Call this before
   * provisioning or as a standalone health check.
   *
   * @throws {OrgError} When prerequisites are not met
   */
  async validatePrerequisites() {
    this.logger?.debug("Validating devhub prerequisites...");
    await this.provider.validate();
    this.logger?.debug("Prerequisites validated");
  }
  /**
   * Build batch definitions for org creation.
   * @param tag The pool tag, used as the alias prefix (e.g. `ci-1`, `CI1`).
   * @param type The pool type — sandbox aliases are uppercased with hyphens stripped.
   * @param count The total number of orgs to create.
   * @param concurrency The maximum number of orgs to create concurrently.
   * @returns An array of batches, each containing org aliases and their indices.
   */
  buildBatchDefinitions(tag, type, count, concurrency) {
    const isSandboxPool = type === import_core6.OrgTypes.Sandbox;
    const batches = [];
    for (let batchStart = 0; batchStart < count; batchStart += concurrency) {
      const batchEnd = Math.min(batchStart + concurrency, count);
      const batch = Array.from({ length: batchEnd - batchStart }, (_, i) => ({
        alias: buildPoolAlias(tag, isSandboxPool, batchStart + i + 1),
        index: batchStart + i
      }));
      batches.push(batch);
    }
    return batches;
  }
  /**
   * Build `OrgCreateOptions` from the pool config and an alias.
   *
   * Maps the discriminated pool config union to the generic
   * `OrgCreateOptions` used by the provider.
   */
  buildCreateOptions(config, alias) {
    if (config.type === import_core6.OrgTypes.Sandbox) {
      return {
        alias,
        definitionFile: config.definitionFile,
        namePattern: config.namePattern,
        waitMinutes: config.waitMinutes
      };
    }
    return {
      alias,
      definitionfile: config.definitionFile,
      durationDays: config.expiryDays,
      noancestors: config.noAncestors,
      retry: config.maxRetries
    };
  }
  async cleanupFailedOrgs(orgs, tag) {
    this.logger?.info(`Cleaning up ${orgs.length} org(s) that failed tasks in pool "${tag}"`);
    const undeleted = [];
    for (const org of orgs) {
      try {
        await this.provider.deleteOrgs([org.recordId]);
        this.bus.emit("pool:org:deleted", {
          timestamp: /* @__PURE__ */ new Date(),
          username: org.auth.username
        });
        this.logger?.debug(`Deleted failed org ${org.auth.username}`);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.logger?.warn(`Failed to delete org ${org.auth.username ?? org.recordId}: ${message}`);
        undeleted.push(org);
      }
    }
    if (undeleted.length > 0) {
      this.logger?.warn(`Marking ${undeleted.length} undeleted org(s) as Available to prevent InProgress leak`);
      try {
        await this.markOrgsAvailable(undeleted, tag);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.logger?.error(`Failed to mark orgs as Available \u2014 orgs may be stuck as InProgress: ${message}`);
      }
    }
  }
  async cleanupOrphanedOrgs(orgs) {
    try {
      if (this.provider.cleanupOrgs) {
        await this.provider.cleanupOrgs(orgs);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger?.warn(`Failed to clean up ${orgs.length} orphaned org(s): ${message}`);
    }
  }
  /**
   * Create multiple orgs concurrently, capped at `concurrency`.
   *
   * Replaces the legacy Bottleneck-based approach. Salesforce DevHub has
   * concurrent API request limits, so we use a simple batch pattern
   * instead of firing all requests at once.
   *
   * We process in sequential batches of size `concurrency`. Within each
   * batch, all requests run in parallel. This gives us deterministic
   * concurrency control without any external dependencies.
   */
  async createOrgsWithConcurrency(tag, config, count, concurrency) {
    const batches = this.buildBatchDefinitions(tag, config.type, count, concurrency);
    const allResults = [];
    for (const batch of batches) {
      const batchPromises = batch.map(({ alias, index }) => this.createSingleOrg(tag, config, alias, index, count));
      const settled = await Promise.allSettled(batchPromises);
      const results = settled.map((s) => s.status === "fulfilled" ? s.value : { error: String(s.reason) });
      allResults.push(...results);
    }
    return allResults;
  }
  // --------------------------------------------------------------------------
  // Private helpers
  // --------------------------------------------------------------------------
  /**
   * Create a single org and return the result.
   * Never throws — returns an `OrgProvisionResult` with error info on failure.
   */
  async createSingleOrg(tag, config, alias, index, total) {
    try {
      const createOptions = this.buildCreateOptions(config, alias);
      const org = await this.provider.createOrg(createOptions);
      org.pool = { stage: PoolStage.InProgress, tag, timestamp: Date.now() };
      this.bus.emit("pool:org:created", {
        alias,
        index: index + 1,
        timestamp: /* @__PURE__ */ new Date(),
        total,
        username: org.auth.username
      });
      return { org };
    } catch (error) {
      const message = formatCreateError(error);
      const timedOut = message.includes("timed out");
      const { waitMinutes } = config;
      this.bus.emit("pool:org:failed", {
        alias,
        error: message,
        index: index + 1,
        timedOut,
        timestamp: /* @__PURE__ */ new Date()
      });
      if (timedOut) {
        this.logger?.warn(`Org "${alias}" creation timed out \u2014 consider increasing waitMinutes (current: ${waitMinutes ?? 6}min)`);
      } else {
        this.logger?.warn(`Org "${alias}" creation failed: ${message}`);
      }
      return { error: message, timedOut };
    }
  }
  /**
   * Execute a single task, catching errors so one task can't crash
   * the entire provisioning run.
   */
  async executeSingleTask(task, org, orgLogger) {
    try {
      return await task.execute(org, orgLogger ?? noopLogger);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      orgLogger?.error(`Task "${task.name}" failed: ${message}`);
      return { error: message, success: false };
    }
  }
  handleZeroAllocation(tag, config, allocation, startTime) {
    const reason = allocation.remaining > 0 ? `Pool "${tag}" is at maximum capacity (${config.sizing.max})` : "No remaining scratch org capacity on the DevHub";
    this.logger?.info(reason);
    return {
      elapsedMs: Date.now() - startTime,
      errors: [reason],
      failed: 0,
      succeeded: [],
      tag
    };
  }
  // --------------------------------------------------------------------------
  // Private — Task execution
  // --------------------------------------------------------------------------
  /**
   * Transition orgs from InProgress to Available after tasks complete.
   *
   * When tasks are configured, only orgs where all tasks succeeded are
   * marked Available. Orgs with failed tasks remain InProgress (visible
   * in `pool list` but not claimable by `getAvailableByTag`).
   *
   * When no tasks are configured, all orgs are marked Available.
   */
  async markOrgsAvailable(orgs, tag, taskResults) {
    let successfulOrgs;
    if (taskResults) {
      const succeededUsernames = new Set(taskResults.filter((r) => r.success).map((r) => r.username));
      successfulOrgs = orgs.filter((org) => succeededUsernames.has(org.auth.username));
    } else {
      successfulOrgs = orgs;
    }
    if (successfulOrgs.length === 0) {
      this.logger?.warn("No orgs to mark as Available \u2014 all tasks failed");
      return [];
    }
    const records = successfulOrgs.filter((org) => org.recordId).map((org) => ({
      authUrl: org.auth.authUrl,
      id: org.recordId,
      poolTag: tag,
      stage: PoolStage.Available
    }));
    if (records.length > 0) {
      await this.provider.updatePoolMetadata(records);
      this.logger?.info(`Marked ${records.length} org(s) as Available in pool "${tag}"`);
    }
    return successfulOrgs;
  }
  /**
   * Fetch record IDs from the DevHub and update pool metadata.
   */
  async registerInPool(orgs, tag) {
    const enrichedOrgs = await this.provider.getRecordIds(orgs);
    const records = enrichedOrgs.filter((org) => org.recordId).map((org) => ({
      authUrl: org.auth.authUrl,
      id: org.recordId,
      poolTag: tag,
      stage: PoolStage.InProgress
    }));
    if (records.length > 0) {
      await this.provider.updatePoolMetadata(records);
      this.logger?.debug(`Registered ${records.length} org(s) in pool "${tag}" as InProgress`);
    }
    return enrichedOrgs.filter((org) => org.recordId);
  }
  /**
   * Run preparation tasks on provisioned orgs with concurrency control.
   *
   * Each org gets a scoped logger from the `PoolOrgLoggerFactory`.
   * Tasks run sequentially per org (order matters — deploy before
   * scripts), but multiple orgs are processed concurrently up to
   * `concurrency`.
   *
   * Uses a worker-pool pattern: `concurrency` workers pull orgs from
   * a shared queue. As soon as one org finishes, the next starts —
   * unlike the org-creation phase which uses rigid sequential batches
   * (required by Salesforce API limits), task execution benefits from
   * filling slots immediately.
   */
  async runTasksOnOrgs(orgs) {
    this.logger?.info(`Running ${this.tasks.length} task(s) on ${orgs.length} org(s)...`);
    const summaries = await Promise.all(orgs.map((org) => this.runTasksOnSingleOrg(org)));
    if (this.loggerFactory?.dispose) {
      await this.loggerFactory.dispose();
    }
    const succeeded = summaries.filter((s) => s.success).length;
    this.logger?.info(`Tasks complete: ${succeeded}/${summaries.length} org(s) fully prepared`);
    return summaries;
  }
  /**
   * Run all registered tasks sequentially on a single scratch org.
   *
   * Creates a scoped logger for the org, then executes each task in
   * order. If a task fails and `continueOnError` is false, remaining
   * tasks are skipped.
   */
  async runTasksOnSingleOrg(org) {
    const orgLogger = this.loggerFactory?.create(org) ?? this.logger?.child?.({ org: org.auth.username }) ?? this.logger;
    const results = [];
    let aborted = false;
    for (const task of this.tasks) {
      if (aborted) {
        results.push({ error: "Skipped (previous task failed)", success: false, task: task.name });
        continue;
      }
      this.bus.emit("pool:task:start", {
        task: task.name,
        timestamp: /* @__PURE__ */ new Date(),
        username: org.auth.username
      });
      const taskResult = await this.executeSingleTask(task, org, orgLogger);
      results.push({ error: taskResult.error, success: taskResult.success, task: task.name });
      if (taskResult.success) {
        this.bus.emit("pool:task:complete", {
          success: true,
          task: task.name,
          timestamp: /* @__PURE__ */ new Date(),
          username: org.auth.username
        });
      } else {
        this.bus.emit("pool:task:error", {
          error: taskResult.error ?? "Unknown error",
          task: task.name,
          timestamp: /* @__PURE__ */ new Date(),
          username: org.auth.username
        });
        if (!task.continueOnError) {
          aborted = true;
        }
      }
    }
    return {
      results,
      success: results.every((r, i) => r.success || this.tasks[i].continueOnError),
      username: org.auth.username
    };
  }
  /**
   * Validate that provisioned orgs are actually active.
   *
   * Salesforce can sometimes report orgs as created but they end up
   * in a "Deleted" state. We filter those out before registering
   * them in the pool.
   *
   * All validations run in parallel since they are independent queries.
   */
  async validateOrgs(orgs) {
    const results = await Promise.all(orgs.map((org) => this.validateSingleOrg(org)));
    return results.filter((org) => org !== null);
  }
  /**
   * Validate a single org is active. Returns the org if valid, null if not.
   */
  async validateSingleOrg(org) {
    try {
      const isActive = await this.provider.isOrgActive(org.auth.username);
      if (isActive) {
        this.bus.emit("pool:org:validated", {
          timestamp: /* @__PURE__ */ new Date(),
          username: org.auth.username
        });
        return org;
      }
      this.bus.emit("pool:org:discarded", {
        reason: 'Org has status "Deleted"',
        timestamp: /* @__PURE__ */ new Date(),
        username: org.auth.username
      });
      this.logger?.warn(`Discarding org ${org.auth.username} \u2014 reported as deleted`);
      return null;
    } catch (error) {
      this.bus.emit("pool:org:discarded", {
        reason: error instanceof Error ? error.message : String(error),
        timestamp: /* @__PURE__ */ new Date(),
        username: org.auth.username
      });
      this.logger?.warn(`Unable to verify org ${org.auth.username}, discarding: ${error instanceof Error ? error.message : error}`);
      return null;
    }
  }
};
function computeOrgAllocation(remainingScratchOrgs, currentActiveCount, sizing) {
  const toSatisfyMax = Math.max(0, sizing.max - currentActiveCount);
  let toAllocate = 0;
  if (toSatisfyMax > 0) {
    toAllocate = Math.min(toSatisfyMax, remainingScratchOrgs);
  }
  return {
    currentAllocation: currentActiveCount,
    remaining: remainingScratchOrgs,
    toAllocate,
    toSatisfyMax
  };
}
var noop = () => {
};
var noopLogger = {
  debug: noop,
  error: noop,
  info: noop,
  trace: noop,
  warn: noop
};

// ../orgs/dist/pool/tasks/deployment-task.js
var import_core7 = __toESM(require_lib(), 1);
var DeploymentTask = class {
  continueOnError;
  name = "deploy-packages";
  forwarder;
  options;
  projectServicePromise;
  constructor(options) {
    this.options = options;
    this.continueOnError = options.continueOnError;
  }
  async execute(org, logger) {
    const { username } = org.auth;
    if (!username) {
      return { error: "Org has no username", success: false };
    }
    const targetOrg = await import_core7.Org.create({ aliasOrUsername: username });
    const projectService = await this.getProjectService();
    const provider = projectService.getDefinitionProvider();
    const graph = projectService.getProjectGraph();
    const packages = this.resolvePackages(provider.getAllPackageNames(), logger);
    if (packages.length === 0) {
      logger.info("No packages to deploy \u2014 skipping deployment");
      return { success: true };
    }
    logger.info(`Deploying ${packages.length} package(s) to ${username}`);
    const installer = new PackageInstaller(targetOrg, provider, { force: true, testLevel: this.options.testLevel ?? "NoTestRun", unlocked: { sourceOnly: true } }, logger);
    const orchestrator = new InstallOrchestrator(graph, installer, {
      continueOnError: true,
      includeManagedPackages: true
    }, logger);
    if (this.forwarder) {
      let total = 0;
      const versionBuffer = /* @__PURE__ */ new Map();
      const fw = this.forwarder;
      orchestrator.orchestrationBus.on("start", (e) => {
        total = e.levels.flat().length;
      });
      orchestrator.installBus.on("start", (e) => {
        fw.packageStart({ packageName: e.packageName, total, username });
      });
      orchestrator.installBus.on("complete", (e) => {
        if (e.versionNumber)
          versionBuffer.set(e.packageName, e.versionNumber);
      });
      orchestrator.orchestrationBus.on("package:complete", (e) => {
        fw.packageComplete({
          packageName: e.packageName,
          success: !e.skipped && Boolean(e.success),
          total,
          username,
          version: versionBuffer.get(e.packageName)
        });
        versionBuffer.delete(e.packageName);
      });
    }
    const result = await orchestrator.installAll(packages);
    if (!result.success) {
      const failed = result.failedPackages.join(", ");
      return { error: `Failed to deploy: ${failed}`, success: false };
    }
    return { success: true };
  }
  setPackageForwarder(forwarder) {
    this.forwarder = forwarder;
  }
  /**
   * Resolve the provider matching `useLocalSource`:
   * - `true` — {@link WorkspaceProvider} (dist-aware) deploying live project source.
   * - `false` (default) — {@link ArtifactProvider} reading published artifacts
   *   already installed into `workingDirectory`'s `node_modules`.
   *
   * Cached per task instance since the same task runs once per pool org.
   */
  getProjectService() {
    this.projectServicePromise ??= this.options.useLocalSource ? ProjectService.create(this.options.workingDirectory, new WorkspaceProvider({ distAware: true, projectDir: this.options.workingDirectory })) : ProjectService.create(this.options.workingDirectory, new ArtifactProvider({ projectDir: this.options.workingDirectory }));
    return this.projectServicePromise;
  }
  /**
   * Filter packages based on include/exclude options.
   */
  resolvePackages(allPackages, logger) {
    const { exclude, include } = this.options;
    if (include && include.length > 0) {
      const filtered = allPackages.filter((name) => include.includes(name));
      logger.debug(`Include filter: ${filtered.length}/${allPackages.length} packages selected`);
      return filtered;
    }
    if (exclude && exclude.length > 0) {
      const filtered = allPackages.filter((name) => !exclude.includes(name));
      logger.debug(`Exclude filter: ${filtered.length}/${allPackages.length} packages selected`);
      return filtered;
    }
    return allPackages;
  }
};

// ../orgs/dist/pool/tasks/sfpm-package-install-task.js
var import_core8 = __toESM(require_lib(), 1);
var SFPM_PACKAGE_NAME = "sfpm-artifact";
var MANAGE_ARTIFACTS_PERMSET = "Manage_Artifacts";
var SfpmPackageInstallTask = class {
  continueOnError;
  name = "install-sfpm-package";
  devhub;
  constructor(options) {
    this.devhub = options.devhub;
    this.continueOnError = options.continueOnError ?? false;
  }
  async execute(org, logger) {
    const { username } = org.auth;
    if (!username) {
      return { error: "Org has no username", success: false };
    }
    const subscriberVersionId = await this.resolveLatestVersion(logger);
    if (!subscriberVersionId) {
      return {
        error: `Package "${SFPM_PACKAGE_NAME}" not found on the DevHub \u2014 run "sfpm bootstrap" first`,
        success: false
      };
    }
    logger.info(`Resolved ${SFPM_PACKAGE_NAME} subscriber version: ${subscriberVersionId}`);
    const scratchOrg = await import_core8.Org.create({ aliasOrUsername: username });
    const connection = scratchOrg.getConnection();
    const packageService = new PackageService(scratchOrg, logger);
    const alreadyInstalled = await packageService.isSubscriberVersionInstalled(subscriberVersionId);
    if (alreadyInstalled) {
      logger.info(`${SFPM_PACKAGE_NAME} (${subscriberVersionId}) already installed \u2014 skipping`);
      await this.assignManageArtifactsPermSet(connection, username, logger);
      return { success: true };
    }
    logger.info(`Installing ${SFPM_PACKAGE_NAME} (${subscriberVersionId}) to ${username}...`);
    try {
      await packageService.installPackage(subscriberVersionId, {
        apexCompile: "package",
        securityType: "AllUsers",
        wait: 10
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { error: `Package installation failed: ${message}`, success: false };
    }
    logger.info(`${SFPM_PACKAGE_NAME} installed successfully`);
    await this.assignManageArtifactsPermSet(connection, username, logger);
    return { success: true };
  }
  /**
   * Assign the `Manage_Artifacts` permission set to the running user, so
   * they can actually access `Sfpm_Artifact__c` (object exists once the
   * package is installed, but access still requires the permission set).
   *
   * Idempotent — checks for an existing assignment first. Degrades
   * gracefully (logs a warning, doesn't fail the task) if the permission
   * set isn't found or the assignment otherwise fails.
   */
  async assignManageArtifactsPermSet(connection, username, logger) {
    try {
      const userResult = await connection.query(soql`SELECT Id FROM User WHERE Username = '${escapeSOQL(username)}' LIMIT 1`);
      const userId = userResult.records[0]?.Id;
      if (!userId) {
        logger.warn(`Could not resolve user Id for ${username} \u2014 skipping ${MANAGE_ARTIFACTS_PERMSET} assignment`);
        return;
      }
      const permSetResult = await connection.query(soql`SELECT Id FROM PermissionSet WHERE Name = '${escapeSOQL(MANAGE_ARTIFACTS_PERMSET)}' LIMIT 1`);
      const permSetId = permSetResult.records[0]?.Id;
      if (!permSetId) {
        logger.warn(`Permission set "${MANAGE_ARTIFACTS_PERMSET}" not found in org \u2014 skipping assignment`);
        return;
      }
      const existing = await connection.query(soql`SELECT Id FROM PermissionSetAssignment WHERE AssigneeId = '${userId}' AND PermissionSetId = '${permSetId}' LIMIT 1`);
      if (existing.records.length > 0) {
        logger.debug(`${MANAGE_ARTIFACTS_PERMSET} already assigned to ${username}`);
        return;
      }
      await connection.sobject("PermissionSetAssignment").create({ AssigneeId: userId, PermissionSetId: permSetId });
      logger.info(`Assigned "${MANAGE_ARTIFACTS_PERMSET}" permission set to ${username}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.warn(`Failed to assign "${MANAGE_ARTIFACTS_PERMSET}" permission set to ${username}: ${message}`);
    }
  }
  /**
   * Query the DevHub for the latest released version of the
   * `sfpm-artifact` Package2 and return its subscriber version ID.
   */
  async resolveLatestVersion(logger) {
    const packageService = new PackageService(this.devhub, logger);
    const allPackages = await packageService.listPackages();
    const sfpmPackage = allPackages.find((p) => p.Name === SFPM_PACKAGE_NAME);
    if (!sfpmPackage) {
      logger.warn(`Package "${SFPM_PACKAGE_NAME}" not found on DevHub`);
      return void 0;
    }
    const versions = await packageService.listPackageVersions({
      isReleased: true,
      packages: [sfpmPackage.Id]
    });
    if (versions.length === 0) {
      logger.warn(`No released versions found for "${SFPM_PACKAGE_NAME}"`);
      return void 0;
    }
    return versions[0].SubscriberPackageVersionId;
  }
};

// ../orgs/dist/org/sandbox/sandbox-provider.js
var SANDBOX_POOL_ORG_OBJECT = "Sandbox_Pool_Org__c";
var SANDBOX_INFO_FIELDS = [
  "AutoActivate",
  "CreatedDate",
  "EndDate",
  "Id",
  "LicenseType",
  "SandboxName",
  "SandboxOrganization",
  "Status"
];
var SANDBOX_POOL_ORG_FIELDS = [
  "Stage__c",
  "Auth_Url__c",
  "CreatedDate",
  "Id",
  "Org_Id__c",
  "Tag__c"
];
var REQUIRED_STAGES2 = [
  PoolStage.Available,
  PoolStage.InProgress,
  PoolStage.Assigned
];
var PRUNE_COOLDOWN_MS = 6e4;
var SandboxProvider = class {
  conn;
  hubOrg;
  hubUsername;
  /** Timestamp of the last successful prune run — used for cooldown. */
  lastPruneTimestamp = 0;
  constructor(hubOrg) {
    this.conn = hubOrg.getConnection();
    this.hubOrg = hubOrg;
    this.hubUsername = hubOrg.getUsername() ?? "";
  }
  async claimOrg(id) {
    try {
      const result = await this.conn.sobject(SANDBOX_POOL_ORG_OBJECT).update({
        Id: id,
        Stage__c: "Assigned"
        // eslint-disable-line camelcase -- Salesforce custom field
      });
      return result.success === true;
    } catch {
      return false;
    }
  }
  async createOrg(options) {
    const defContents = await this.readDefinitionFile(options.definitionFile);
    const waitMinutes = options.waitMinutes ?? DEFAULT_SANDBOX.waitMinutes;
    const baseName = options.namePattern ?? defContents.SandboxName;
    const index = options.alias.replaceAll(/\D/g, "");
    const sandboxName = `${baseName}${index}`;
    defContents.SandboxName = sandboxName;
    if (defContents.ApexClassName) {
      defContents.ApexClassId = await this.resolveApexClassId(defContents.ApexClassName);
      delete defContents.ApexClassName;
    }
    if (defContents.ActivationUserGroupName) {
      defContents.ActivationUserGroupId = await this.getGroupId(defContents.ActivationUserGroupName);
      delete defContents.ActivationUserGroupName;
    }
    const sourceSandboxName = defContents.SourceSandboxName;
    const sourceId = defContents.SourceId;
    delete defContents.SourceSandboxName;
    delete defContents.SourceId;
    const sandboxRequest = defContents;
    let processResult;
    if (sourceSandboxName) {
      processResult = await this.hubOrg.cloneSandbox(sandboxRequest, sourceSandboxName, {
        interval: import_kit2.Duration.seconds(30),
        wait: import_kit2.Duration.minutes(waitMinutes)
      });
    } else if (sourceId) {
      processResult = await this.hubOrg.cloneSandbox(sandboxRequest, sourceId, {
        interval: import_kit2.Duration.seconds(30),
        wait: import_kit2.Duration.minutes(waitMinutes)
      });
    } else {
      processResult = await this.hubOrg.createSandbox(sandboxRequest, {
        async: false,
        interval: import_kit2.Duration.seconds(30),
        wait: import_kit2.Duration.minutes(waitMinutes)
      });
    }
    const orgId = processResult.SandboxOrganization ?? "";
    const sandboxUsername = orgId ? await this.resolveSandboxUsername(sandboxName) : "";
    const poolRecord = await this.conn.sobject(SANDBOX_POOL_ORG_OBJECT).create({
      Org_Id__c: orgId,
      // eslint-disable-line camelcase -- Salesforce custom field
      Stage__c: PoolStage.InProgress,
      // eslint-disable-line camelcase -- Salesforce custom field
      Tag__c: ""
      // eslint-disable-line camelcase -- Salesforce custom field (set later by updatePoolMetadata)
    });
    const sandbox = {
      auth: {
        alias: options.alias,
        loginUrl: "https://test.salesforce.com",
        username: sandboxUsername
      },
      orgId,
      orgType: import_core9.OrgTypes.Sandbox,
      pool: {
        stage: PoolStage.InProgress,
        tag: "",
        timestamp: Date.now()
      },
      recordId: poolRecord.id
    };
    return sandbox;
  }
  async deleteOrgs(recordIds) {
    for (const recordId of recordIds) {
      try {
        const poolRecord = await this.conn.sobject(SANDBOX_POOL_ORG_OBJECT).retrieve(recordId);
        if (poolRecord?.Org_Id__c) {
          const sandboxInfoResult = await this.conn.query(soql`SELECT Id, SandboxName FROM SandboxInfo WHERE SandboxOrganization = '${escapeSOQL(poolRecord.Org_Id__c)}'`);
          const sandboxName = sandboxInfoResult.records[0]?.SandboxName;
          if (sandboxName) {
            const process = await this.hubOrg.querySandboxProcessBySandboxName(sandboxName);
            if (process?.SandboxOrganization) {
              const sandboxOrg = await import_core9.Org.create({ aliasOrUsername: process.SandboxOrganization });
              await sandboxOrg.deleteFrom(this.hubOrg);
            }
          }
        }
      } catch {
      }
      try {
        await this.conn.sobject(SANDBOX_POOL_ORG_OBJECT).destroy(recordId);
      } catch {
      }
    }
  }
  async getActiveCountByTag(tag) {
    await this.pruneStalePoolRecords();
    const query = soql`SELECT count() FROM ${SANDBOX_POOL_ORG_OBJECT} WHERE Tag__c = '${escapeSOQL(tag)}'`;
    const result = await this.conn.query(query);
    return result.totalSize;
  }
  async getAvailableByTag(tag, myPool) {
    await this.pruneStalePoolRecords();
    const escapedTag = escapeSOQL(tag);
    const conditions = [
      `Tag__c = '${escapedTag}'`,
      `(Stage__c = '${PoolStage.Available}' OR Stage__c = '${PoolStage.InProgress}')`
    ];
    if (myPool) {
      conditions.push(`CreatedById = '${escapeSOQL(this.hubUsername)}'`);
    }
    const poolQuery = soql`SELECT ${SANDBOX_POOL_ORG_FIELDS.join(", ")} FROM ${SANDBOX_POOL_ORG_OBJECT} WHERE ${conditions.join(" AND ")} ORDER BY CreatedDate DESC`;
    const poolResult = await this.conn.query(poolQuery);
    if (poolResult.records.length === 0)
      return [];
    return this.enrichPoolRecords(poolResult.records);
  }
  async getOrgsByTag(tag, myPool) {
    await this.pruneStalePoolRecords();
    const conditions = [];
    if (tag) {
      conditions.push(`Tag__c = '${escapeSOQL(tag)}'`);
    } else {
      conditions.push("Tag__c != null");
    }
    if (myPool) {
      conditions.push(`CreatedById = '${escapeSOQL(this.hubUsername)}'`);
    }
    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    const poolQuery = soql`SELECT ${SANDBOX_POOL_ORG_FIELDS.join(", ")} FROM ${SANDBOX_POOL_ORG_OBJECT} ${whereClause} ORDER BY CreatedDate DESC`;
    const poolResult = await this.conn.query(poolQuery);
    if (poolResult.records.length === 0)
      return [];
    return this.enrichPoolRecords(poolResult.records);
  }
  async getOrgUsageByUser() {
    return [];
  }
  /**
   * Find active sandboxes that have no corresponding pool record.
   *
   * Performs an in-memory diff: queries all active `SandboxInfo` records
   * and all `Sandbox_Pool_Org__c` records, then returns sandboxes whose
   * org ID is not tracked by any pool record.
   */
  async getOrphanedOrgs() {
    const sandboxQuery = soql`SELECT ${SANDBOX_INFO_FIELDS.join(", ")} FROM SandboxInfo WHERE Status = 'Active' ORDER BY CreatedDate DESC`;
    const sandboxResult = await this.conn.query(sandboxQuery);
    if (sandboxResult.records.length === 0)
      return [];
    const poolQuery = soql`SELECT Org_Id__c FROM ${SANDBOX_POOL_ORG_OBJECT}`;
    const poolResult = await this.conn.query(poolQuery);
    const managedOrgIds = new Set(poolResult.records.map((r) => r.Org_Id__c));
    return sandboxResult.records.filter((r) => r.SandboxOrganization && !managedOrgIds.has(r.SandboxOrganization)).map((r) => mapFromSandboxInfo(r));
  }
  async getRecordIds(orgs) {
    if (orgs.length === 0)
      return orgs;
    const missingIds = orgs.filter((org) => !org.recordId && org.orgId);
    if (missingIds.length === 0)
      return orgs;
    const orgIdList = missingIds.map((org) => `'${escapeSOQL(org.orgId)}'`).join(",");
    const query = soql`SELECT Id, Org_Id__c FROM ${SANDBOX_POOL_ORG_OBJECT} WHERE Org_Id__c IN (${orgIdList})`;
    const result = await this.conn.query(query);
    const idMap = /* @__PURE__ */ new Map();
    for (const record of result.records) {
      if (record.Org_Id__c) {
        idMap.set(record.Org_Id__c, record.Id);
      }
    }
    for (const org of missingIds) {
      const recordId = idMap.get(org.orgId);
      if (recordId) {
        org.recordId = recordId;
      }
    }
    return orgs;
  }
  async getRemainingCapacity() {
    try {
      const entitlementQuery = "SELECT Setting, CurrentAmountAllowed FROM TenantUsageEntitlement WHERE Setting LIKE '%Sandbox%'";
      const entitlementResult = await this.conn.query(entitlementQuery);
      let totalAllowed = 0;
      for (const record of entitlementResult.records) {
        totalAllowed += record.CurrentAmountAllowed ?? 0;
      }
      if (totalAllowed === 0) {
        return Number.MAX_SAFE_INTEGER;
      }
      const activeCount = await this.getActiveSandboxCount();
      return Math.max(0, totalAllowed - activeCount);
    } catch {
      return Number.MAX_SAFE_INTEGER;
    }
  }
  async isOrgActive(username) {
    const sandboxName = this.extractSandboxName(username);
    if (!sandboxName)
      return false;
    try {
      const process = await this.hubOrg.querySandboxProcessBySandboxName(sandboxName);
      return process?.Status === "Completed" || process?.Status === "Active";
    } catch {
      return false;
    }
  }
  async setPassword(username, password) {
    const newPassword = password ?? await generatePassword();
    return { password: newPassword };
  }
  /** Update fields on a SandboxInfo record (standard fields only). */
  async updateOrgInfo(fields) {
    const result = await this.conn.sobject("SandboxInfo").update(fields);
    return result.success === true;
  }
  async updatePoolMetadata(records) {
    if (records.length === 0)
      return;
    const updates = records.map((r) => ({
      Auth_Url__c: r.authUrl,
      // eslint-disable-line camelcase -- Salesforce custom field
      Id: r.id,
      Stage__c: r.stage,
      // eslint-disable-line camelcase -- Salesforce custom field
      Tag__c: r.poolTag
      // eslint-disable-line camelcase -- Salesforce custom field
    }));
    const results = await this.conn.sobject(SANDBOX_POOL_ORG_OBJECT).update(updates);
    const failures = (Array.isArray(results) ? results : [results]).filter((r) => !r.success);
    if (failures.length > 0 && failures.length === updates.length) {
      const errors = failures.flatMap((f) => f.errors?.map((e) => e.message) ?? ["unknown error"]);
      throw new OrgError("update", `Failed to update pool metadata on all ${failures.length} record(s): ${errors.join("; ")}`);
    }
  }
  async validate() {
    await this.pruneStalePoolRecords();
    let describe;
    try {
      describe = await this.conn.sobject(SANDBOX_POOL_ORG_OBJECT).describe();
    } catch {
      throw new OrgError("prerequisite", `The custom object "${SANDBOX_POOL_ORG_OBJECT}" was not found. Deploy the sfpm sandbox pool custom object to your production org before running sandbox pool operations.`);
    }
    const orgIdField = describe.fields.find((f) => f.name === "Org_Id__c");
    if (!orgIdField) {
      throw new OrgError("prerequisite", `${SANDBOX_POOL_ORG_OBJECT} is missing the "Org_Id__c" field. Deploy the sfpm sandbox pool custom object to your production org.`);
    }
    const tagField = describe.fields.find((f) => f.name === "Tag__c");
    if (!tagField) {
      throw new OrgError("prerequisite", `${SANDBOX_POOL_ORG_OBJECT} is missing the "Tag__c" field. Deploy the sfpm sandbox pool custom object to your production org.`);
    }
    const stageField = describe.fields.find((f) => f.name === "Stage__c");
    if (!stageField) {
      throw new OrgError("prerequisite", `${SANDBOX_POOL_ORG_OBJECT} is missing the "Stage__c" field. Deploy the sfpm sandbox pool custom object to your production org.`);
    }
    const picklistValues = new Set((stageField.picklistValues ?? []).map((v) => v.value));
    const missing = REQUIRED_STAGES2.filter((s) => !picklistValues.has(s));
    if (missing.length > 0) {
      throw new OrgError("prerequisite", `Stage__c on ${SANDBOX_POOL_ORG_OBJECT} is missing required picklist values: ${missing.join(", ")}. Update the picklist on ${SANDBOX_POOL_ORG_OBJECT} in your production org.`, { context: { existing: [...picklistValues], missing } });
    }
    const authUrlField = describe.fields.find((f) => f.name === "Auth_Url__c");
    if (!authUrlField) {
      throw new OrgError("prerequisite", `${SANDBOX_POOL_ORG_OBJECT} is missing the "Auth_Url__c" field. Deploy the sfpm sandbox pool custom object to your production org.`);
    }
  }
  /**
   * Enrich pool records with standard `SandboxInfo` fields.
   *
   * Queries `SandboxInfo` by org IDs found on the pool records, then
   * merges both result sets into `Sandbox` domain objects.
   *
   * Pool records whose `Org_Id__c` has no matching active `SandboxInfo`
   * record are silently dropped — they represent stale shadow records
   * for sandboxes that were deleted or expired outside of pool management.
   * These will be cleaned up by the next prune cycle.
   */
  async enrichPoolRecords(poolRecords) {
    const orgIds = poolRecords.map((r) => r.Org_Id__c).filter(Boolean);
    if (orgIds.length === 0) {
      return poolRecords.map((r) => mapFromPoolRecord(r));
    }
    const orgIdList = orgIds.map((orgId) => `'${escapeSOQL(orgId)}'`).join(",");
    const infoQuery = soql`SELECT ${SANDBOX_INFO_FIELDS.join(", ")} FROM SandboxInfo WHERE SandboxOrganization IN (${orgIdList})`;
    const infoResult = await this.conn.query(infoQuery);
    const infoMap = /* @__PURE__ */ new Map();
    for (const record of infoResult.records) {
      if (record.SandboxOrganization) {
        infoMap.set(record.SandboxOrganization, record);
      }
    }
    return poolRecords.filter((poolRec) => {
      if (!poolRec.Org_Id__c)
        return true;
      return infoMap.has(poolRec.Org_Id__c);
    }).map((poolRec) => {
      const info = poolRec.Org_Id__c ? infoMap.get(poolRec.Org_Id__c) : void 0;
      return mapFromPoolRecord(poolRec, info);
    });
  }
  /**
   * Extract the sandbox name suffix from a username.
   *
   * Salesforce sandbox usernames follow the pattern `user@example.com.sandboxname`.
   */
  extractSandboxName(username) {
    const parts = username.split(".");
    return parts.length > 2 ? parts.at(-1) : void 0;
  }
  /** Count sandboxes currently active on the production org. */
  async getActiveSandboxCount() {
    const result = await this.conn.query(soql`SELECT count() FROM SandboxInfo WHERE Status IN ('Active', 'Completed')`);
    return result.totalSize;
  }
  async getGroupId(groupName) {
    const query = soql`SELECT Id FROM Group WHERE Name = '${escapeSOQL(groupName)}'`;
    const result = await this.conn.query(query);
    if (result.records.length === 0) {
      throw new OrgError("fetch", `No group found with name ${groupName} in the devhub org.`);
    }
    return result.records[0].Id;
  }
  /**
   * Remove `Sandbox_Pool_Org__c` records whose associated sandbox no
   * longer exists or has been deleted.
   *
   * Compares all pool records' `Org_Id__c` values against `SandboxInfo`
   * to find stale references, then bulk-deletes them.  Runs at most once
   * per {@link PRUNE_COOLDOWN_MS} within the same provider instance so
   * that repeated pool operations in a single session do not hammer the
   * API.
   *
   * This is intentionally fire-and-forget: failures are swallowed so that
   * pruning never blocks the primary operation.
   */
  async pruneStalePoolRecords() {
    if (Date.now() - this.lastPruneTimestamp < PRUNE_COOLDOWN_MS)
      return;
    try {
      const poolQuery = soql`SELECT Id, Org_Id__c FROM ${SANDBOX_POOL_ORG_OBJECT}`;
      const poolResult = await this.conn.query(poolQuery);
      if (poolResult.records.length === 0) {
        this.lastPruneTimestamp = Date.now();
        return;
      }
      const orgIdToPoolIds = /* @__PURE__ */ new Map();
      const noOrgIdPoolIds = [];
      for (const rec of poolResult.records) {
        if (rec.Org_Id__c) {
          const list = orgIdToPoolIds.get(rec.Org_Id__c) ?? [];
          list.push(rec.Id);
          orgIdToPoolIds.set(rec.Org_Id__c, list);
        } else {
          noOrgIdPoolIds.push(rec.Id);
        }
      }
      const stalePoolIds = [...noOrgIdPoolIds];
      if (orgIdToPoolIds.size > 0) {
        const orgIdList = [...orgIdToPoolIds.keys()].map((id) => `'${escapeSOQL(id)}'`).join(",");
        const infoQuery = soql`SELECT SandboxOrganization FROM SandboxInfo WHERE SandboxOrganization IN (${orgIdList})`;
        const infoResult = await this.conn.query(infoQuery);
        const activeOrgIds = new Set(infoResult.records.map((r) => r.SandboxOrganization));
        for (const [orgId, poolIds] of orgIdToPoolIds) {
          if (!activeOrgIds.has(orgId)) {
            stalePoolIds.push(...poolIds);
          }
        }
      }
      if (stalePoolIds.length > 0) {
        await this.conn.sobject(SANDBOX_POOL_ORG_OBJECT).destroy(stalePoolIds);
      }
      this.lastPruneTimestamp = Date.now();
    } catch {
      this.lastPruneTimestamp = Date.now();
    }
  }
  /**
   * Read a sandbox definition JSON file and capitalize keys to match
   * the Salesforce API field names (e.g., `sandboxName` → `SandboxName`).
   *
   * Returns a mutable record so the caller can override/remove fields
   * before passing it to the SDK.
   */
  async readDefinitionFile(filePath) {
    try {
      const content = await readFile(filePath, "utf8");
      const parsed = JSON.parse(content);
      return Object.fromEntries(Object.entries(parsed).map(([key, value]) => [key.charAt(0).toUpperCase() + key.slice(1), value]));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new OrgError("prerequisite", `Failed to read sandbox definition file "${filePath}": ${message}`);
    }
  }
  /** Resolve an Apex class name to its Salesforce ID. */
  async resolveApexClassId(className) {
    const result = await this.conn.query(soql`SELECT Id FROM ApexClass WHERE Name = '${escapeSOQL(className)}'`);
    if (result.records.length === 0) {
      throw new OrgError("prerequisite", `No Apex class found with name "${className}"`);
    }
    return result.records[0].Id;
  }
  /**
   * Resolve the sandbox username from the sandbox name.
   *
   * The sandbox username is `<production-username>.<sandboxname>`.
   */
  async resolveSandboxUsername(sandboxName) {
    return `${this.hubUsername}.${sandboxName}`;
  }
};
function mapFromPoolRecord(poolRecord, info) {
  const orgId = poolRecord.Org_Id__c ?? info?.SandboxOrganization ?? "";
  const sandboxName = info?.SandboxName ?? "";
  const tag = poolRecord.Tag__c ?? "";
  const status = poolRecord.Stage__c ?? "";
  return {
    auth: {
      authUrl: poolRecord.Auth_Url__c,
      loginUrl: "https://test.salesforce.com",
      username: sandboxName ? `${sandboxName}` : ""
    },
    expiry: info?.EndDate ? new Date(info.EndDate).getTime() : void 0,
    orgId,
    orgType: import_core9.OrgTypes.Sandbox,
    pool: {
      stage: status,
      tag,
      timestamp: poolRecord.CreatedDate ? new Date(poolRecord.CreatedDate).getTime() : Date.now()
    },
    recordId: poolRecord.Id
  };
}
function mapFromSandboxInfo(record) {
  const orgId = record.SandboxOrganization ?? "";
  const sandboxName = record.SandboxName ?? "";
  return {
    auth: {
      loginUrl: "https://test.salesforce.com",
      username: sandboxName ? `${sandboxName}` : ""
    },
    expiry: record.EndDate ? new Date(record.EndDate).getTime() : void 0,
    orgId,
    orgType: import_core9.OrgTypes.Sandbox,
    pool: {
      stage: "",
      tag: "",
      timestamp: record.CreatedDate ? new Date(record.CreatedDate).getTime() : Date.now()
    }
  };
}

// ../orgs/dist/pool/pool-factory.js
function createPoolServices(options) {
  const { devhub, logger, poolType = import_core10.OrgTypes.Scratch, tasks } = options;
  if (!devhub.getUsername()) {
    throw new Error("org must be authenticated and have a username");
  }
  if (!devhub.isDevHubOrg()) {
    throw new Error("org must be a DevHub");
  }
  const devhubService = new DevHubService(devhub, logger);
  const provider = poolType === import_core10.OrgTypes.Sandbox ? new SandboxProvider(devhub) : new ScratchOrgProvider(devhub);
  const jwtConfig = devhubService.getJwtConfig();
  const authenticator = new AuthService(devhub.getUsername(), jwtConfig.clientId ? jwtConfig : void 0);
  const resolvedTasks = tasks ?? [];
  const manager = new PoolManager({
    logger,
    provider,
    tasks: resolvedTasks
  });
  const fetcher = new PoolFetcher(provider, logger);
  return {
    authenticator,
    devhubService,
    fetcher,
    manager
  };
}

export {
  createPoolServices,
  DeploymentTask,
  SfpmPackageInstallTask
};
