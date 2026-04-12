import * as core from '@actions/core';
import * as github from '@actions/github';
import {
  InstallOrchestrator,
  isStructuredLogger,
  LifecycleEngine,
  type Logger,
  ProjectService,
} from '@b64/sfpm-core';
import {
  createPoolServices,
  PoolOrg,
} from '@b64/sfpm-orgs';
import {AuthInfo, Org} from '@salesforce/core';

import {createGitHubActionsLogger} from './logger.js';
import {type CachedOrgConnection, OrgCacheService} from './org-cache.js';
import {ActionsProgressRenderer} from './progress-renderer.js';

// ============================================================================
// Types
// ============================================================================

export interface ValidatePrOptions {
  /** Cache TTL for scratch orgs in hours (default: 4) */
  cacheTtlHours?: number;
  /** DevHub username or alias */
  devhubUsername: string;
  /** Packages to deploy (empty = all packages in the project) */
  packages?: string[];
  /** Pool tag to fetch scratch orgs from */
  poolTag: string;
  /** Project directory (default: workspace root) */
  projectDir?: string;
}

export interface ValidatePrResult {
  /** Whether a cached org was reused */
  cacheHit: boolean;
  /** Duration in milliseconds */
  duration: number;
  /** Org ID of the scratch org used */
  orgId: string;
  /** Per-package results */
  packages: Array<{
    error?: string;
    packageName: string;
    skipped: boolean;
    success: boolean;
  }>;
  /** PR number */
  prNumber: number;
  /** Whether all deployments succeeded */
  success: boolean;
  /** Username of the scratch org used */
  username: string;
}

// ============================================================================
// PR Validation
// ============================================================================

/**
 * Main entry point for the PR validation GitHub Action.
 *
 * Workflow:
 * 1. Resolve the PR number from the GitHub context
 * 2. Attempt to restore a cached scratch org for this PR
 * 3. If no cache hit, fetch a fresh org from the pool
 * 4. Deploy source changes to the org
 * 5. Cache the org connection for subsequent runs
 * 6. Report results via GitHub Actions outputs
 *
 * @example
 * ```typescript
 * const result = await validatePr({
 *   devhubUsername: 'devhub@myorg.com',
 *   poolTag: 'ci-pool',
 * });
 * ```
 */
export async function validatePr(options: ValidatePrOptions): Promise<ValidatePrResult> {
  const logger = createGitHubActionsLogger({prefix: 'validate-pr'});
  const startTime = Date.now();

  const prNumber = resolvePrNumber();
  const projectDir = options.projectDir ?? process.env.GITHUB_WORKSPACE ?? process.cwd();

  logger.info(`Validating PR #${prNumber}`);
  logger.info(`Project directory: ${projectDir}`);
  logger.info(`DevHub: ${options.devhubUsername}`);
  logger.info(`Pool tag: ${options.poolTag}`);

  // ------------------------------------------------------------------
  // 1. Initialize project
  // ------------------------------------------------------------------
  const projectService = await ProjectService.getInstance(projectDir);
  const projectConfig = projectService.getDefinitionProvider();
  const projectGraph = projectService.getProjectGraph();

  const packageNames = options.packages?.length
    ? options.packages
    : projectConfig.getAllPackageNames();

  logger.info(`Packages to validate: ${packageNames.join(', ')}`);

  // ------------------------------------------------------------------
  // 2. Resolve scratch org (cache or pool)
  // ------------------------------------------------------------------
  const {cacheHit, connection} = await resolveOrg(options, prNumber, logger);

  // ------------------------------------------------------------------
  // 3. Authenticate to the org
  // ------------------------------------------------------------------
  logger.info(`Authenticating to ${connection.username}...`);
  await authenticateOrg(connection, options.devhubUsername, logger);

  // ------------------------------------------------------------------
  // 4. Deploy source to the org
  // ------------------------------------------------------------------
  if (isStructuredLogger(logger)) logger.group('Source Deployment');

  const lifecycle = new LifecycleEngine({logger, stage: 'validate'});
  const sfpmConfig = projectService.getSfpmConfig();
  for (const hooks of sfpmConfig.hooks ?? []) {
    lifecycle.use(hooks);
  }

  const orchestrator = InstallOrchestrator.forSource(
    projectConfig,
    projectGraph,
    {
      includeDependencies: true,
      targetOrg: connection.username,
    },
    logger,
    lifecycle,
  );

  const renderer = new ActionsProgressRenderer(logger);
  renderer.attachToInstaller(orchestrator as any);

  const orchResult = await orchestrator.installAll(packageNames);

  renderer.printSummary();
  if (isStructuredLogger(logger)) logger.groupEnd();

  // ------------------------------------------------------------------
  // 5. Set outputs and return result
  // ------------------------------------------------------------------
  const duration = Date.now() - startTime;
  const result: ValidatePrResult = {
    cacheHit,
    duration,
    orgId: connection.orgId,
    packages: orchResult.results.map(r => ({
      error: r.error,
      packageName: r.packageName,
      skipped: r.skipped,
      success: r.success,
    })),
    prNumber,
    success: orchResult.success,
    username: connection.username,
  };

  setActionOutputs(result);

  if (orchResult.success) {
    logger.info(`PR #${prNumber} validation passed in ${Math.round(duration / 1000)}s`);
  } else {
    const failed = orchResult.failedPackages.join(', ');
    core.setFailed(`Deployment failed for: ${failed}`);
  }

  return result;
}

// ============================================================================
// Org resolution (cache → pool fallback)
// ============================================================================

async function resolveOrg(
  options: ValidatePrOptions,
  prNumber: number,
  logger: Logger,
): Promise<{cacheHit: boolean; connection: CachedOrgConnection}> {
  const orgCache = new OrgCacheService({
    cacheTtlHours: options.cacheTtlHours,
    logger,
    prNumber,
  });

  // Try cache first
  const cached = await orgCache.restore();
  if (cached) {
    logger.info(`Reusing cached org ${cached.username} for PR #${prNumber}`);
    orgCache.setOutputs(cached);
    return {cacheHit: true, connection: cached};
  }

  // Fetch from pool
  logger.info('No cached org available, fetching from pool...');
  const org = await fetchOrgFromPool(options, logger);

  const connection: CachedOrgConnection = {
    cachedAt: Date.now(),
    cacheTtlMs: (options.cacheTtlHours ?? 4) * 60 * 60 * 1000,
    orgId: org.orgId,
    prNumber,
    sfdxAuthUrl: org.auth.authUrl ?? '',
    username: org.auth.username,
  };

  // Cache for future runs
  await orgCache.save(connection);
  orgCache.setOutputs(connection);
  core.setOutput('cache-hit', 'false');

  return {cacheHit: false, connection};
}

// ============================================================================
// Pool fetch
// ============================================================================

async function fetchOrgFromPool(
  options: ValidatePrOptions,
  logger: Logger,
): Promise<PoolOrg> {
  if (isStructuredLogger(logger)) logger.group('Pool Fetch');

  const devhub = await Org.create({aliasOrUsername: options.devhubUsername});
  const {authenticator, fetcher} = createPoolServices({devhub, logger});

  const renderer = new ActionsProgressRenderer(logger);
  renderer.attachToPoolFetcher(fetcher);

  const org = await fetcher.fetch({
    postClaimActions: [org => authenticator.login(org)],
    tag: options.poolTag,
  });

  logger.info(`Fetched org: ${org.auth.username} (${org.orgId})`);
  if (isStructuredLogger(logger)) logger.groupEnd();

  return org;
}

// ============================================================================
// Authentication
// ============================================================================

/**
 * Authenticate to a scratch org using its cached SFDX auth URL
 * or via JWT through the DevHub parent.
 */
async function authenticateOrg(
  connection: CachedOrgConnection,
  devhubUsername: string,
  logger: Logger,
): Promise<void> {
  try {
    // Try sfdxAuthUrl-based auth first (fastest path)
    if (connection.sfdxAuthUrl) {
      logger.debug('Authenticating via SFDX auth URL');
      const authInfo = await AuthInfo.create({
        parentUsername: devhubUsername,
        username: connection.username,
      });
      await authInfo.save();
      // Validate by creating an Org instance
      await Org.create({aliasOrUsername: connection.username});
      logger.debug('Authentication successful');
      return;
    }

    // Fallback: JWT via parent username
    logger.debug('Authenticating via JWT parent username');
    const authInfo = await AuthInfo.create({
      parentUsername: devhubUsername,
      username: connection.username,
    });
    await authInfo.save();
    await Org.create({aliasOrUsername: connection.username});
    logger.debug('Authentication successful');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to authenticate to org ${connection.username}: ${message}`);
  }
}

// ============================================================================
// GitHub context helpers
// ============================================================================

function resolvePrNumber(): number {
  const prNumber = github.context.payload.pull_request?.number;
  if (!prNumber) {
    throw new Error('Could not determine PR number. This action must run on pull_request events.');
  }

  return prNumber;
}

// ============================================================================
// Action outputs
// ============================================================================

function setActionOutputs(result: ValidatePrResult): void {
  core.setOutput('success', String(result.success));
  core.setOutput('org-username', result.username);
  core.setOutput('org-id', result.orgId);
  core.setOutput('cache-hit', String(result.cacheHit));
  core.setOutput('pr-number', String(result.prNumber));
  core.setOutput('duration', String(result.duration));
  core.setOutput('result', JSON.stringify(result));
}
