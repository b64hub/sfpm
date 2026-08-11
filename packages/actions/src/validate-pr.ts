import * as core from '@actions/core';
import * as github from '@actions/github';
import {
  BuildOrchestrator,
  GitService,
  LifecycleEngine,
  type PackageResult,
  type PendingValidationDescriptor,
  type ProjectDefinitionProvider,
  ProjectGraph,
  ProjectService,
  type SfpmConfig,
  ValidationEventBus,
  ValidationResolver,
} from '@b64hub/sfpm-core';
import {
  createPoolServices,
  PoolOrg,
} from '@b64hub/sfpm-orgs';
import {createTracer} from '@b64hub/sfpm-telemetry';
import {NimbusLocalValidator, NimbusValidationEventBus} from '@b64hub/sfpm-validation';
import {AuthInfo, Org, OrgTypes} from '@salesforce/core';
import path from 'node:path';

import {createGitHubActionsLogger, GitHubActionsLogger} from './logger.js';
import {type CachedOrgConnection, OrgCacheService} from './org-cache.js';
import {ActionsProgressRenderer} from './progress-renderer.js';

// ============================================================================
// Types
// ============================================================================

export interface ValidatePrOptions {
  /** Git ref to diff against for changed-package detection (default: PR base SHA from GH context). Only used when `packages` is not set. */
  baseRef?: string;
  /** Cache TTL for scratch orgs in hours (default: 4). Only used in 'org' mode. */
  cacheTtlHours?: number;
  /** DevHub username or alias. Required when mode is 'org' (pool access). */
  devhubUsername?: string;
  /**
   * Validation mode (default: 'local'):
   * - `'local'` — compile + dependency checks via the local nimbus validator
   *   only. No scratch org is fetched from the pool — nothing gets deployed
   *   anywhere. Fast, cheap, no pool org consumed.
   * - `'org'` — deploy + validate against a pooled scratch org. Unlocked
   *   packages are always forced to source-only deploy (no package version
   *   is ever created here — that only happens on push to main, via the
   *   `build` action, so concurrent PRs never race for build numbers).
   */
  mode?: 'local' | 'org';
  /** Packages to deploy (default: only packages changed against `baseRef`, or all packages if no base ref is available) */
  packages?: string[];
  /** Pool tag to fetch scratch orgs from. Required when mode is 'org'. */
  poolTag?: string;
  /** Pool type: scratch or sandbox (inferred from sfpm.config.ts orgs.pools[tag] if omitted, default scratch) */
  poolType?: OrgTypes;
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
    coveragePercentage?: number;
    error?: string;
    packageName: string;
    skipped: boolean;
    success: boolean;
  }>;
  /** PR number */
  prNumber: number;
  /** Whether all validations succeeded */
  success: boolean;
  /** Username of the scratch org used */
  username: string;
}

/** Outcome of resolving a single package's pending deploy validation ('org' mode). */
interface PendingValidationOutcome {
  error?: string;
  status: 'failed' | 'passed';
  testCoverage?: number;
}

// ============================================================================
// PR Validation
// ============================================================================

/**
 * Main entry point for the PR validation GitHub Action.
 *
 * Workflow:
 * 1. Resolve the PR number from the GitHub context
 * 2. `local` mode: build with the local nimbus validator only (compile +
 *    dependency checks) — no scratch org involved.
 *    `org` mode: restore/fetch a pooled scratch org, authenticate, then
 *    build + deploy against it. Unlocked packages are forced source-only.
 * 3. Report results via GitHub Actions outputs
 *
 * Lifecycle stage: **validate**
 *
 * Uses {@link BuildOrchestrator} with `continueOnError: true` so all
 * packages are validated even if earlier ones fail.
 *
 * @example
 * ```typescript
 * const result = await validatePr({
 *   devhubUsername: 'devhub@myorg.com',
 *   mode: 'org',
 *   poolTag: 'ci-pool',
 * });
 * ```
 */
export async function validatePr(options: ValidatePrOptions): Promise<ValidatePrResult> {
  const logger = createGitHubActionsLogger({prefix: 'validate-pr'});
  const startTime = Date.now();
  const mode = options.mode ?? 'local';

  const prNumber = resolvePrNumber();
  const projectDir = options.projectDir ?? process.env.GITHUB_WORKSPACE ?? process.cwd();

  logger.info(`Validating PR #${prNumber}`);
  logger.info(`Project directory: ${projectDir}`);
  logger.info(`Mode: ${mode}`);

  // ------------------------------------------------------------------
  // 1. Initialize project
  // ------------------------------------------------------------------
  const projectService = await ProjectService.getInstance(projectDir);
  const projectConfig = projectService.getDefinitionProvider();
  const projectGraph = projectService.getProjectGraph();
  const sfpmConfig = projectService.getSfpmConfig();

  const packageNames = options.packages?.length
    ? options.packages
    : await resolveChangedPackageNames(projectConfig, options, logger);

  logger.info(`Packages to validate: ${packageNames.join(', ') || '(none — no package changes detected)'}`);

  // ------------------------------------------------------------------
  // 2. Resolve scratch org (cache or pool) — 'org' mode only
  // ------------------------------------------------------------------
  const poolType = resolvePoolType(sfpmConfig, options.poolTag, options.poolType);
  const {cacheHit, connection, scratchOrg} = await resolveScratchOrg(mode, options, poolType, prNumber, logger);

  // ------------------------------------------------------------------
  // 3. Build + validate packages
  // ------------------------------------------------------------------
  const lifecycle = LifecycleEngine.stage('validate');
  for (const hooks of sfpmConfig.hooks ?? []) {
    lifecycle.use(hooks);
  }

  // Local nimbus validator for compile + dependency checks. Used in both
  // modes ('local' relies on it entirely; 'org' still runs dependency checks
  // as a warn-only signal alongside org validation — see ValidationLevel).
  const localValidator = createLocalValidator(projectConfig, logger);

  const orchestrator = new BuildOrchestrator(
    projectConfig,
    projectGraph,
    scratchOrg ? {buildOrg: scratchOrg} : {},
    {
      continueOnError: true,
      includeDependencies: true,
      // 'org' mode always forces source-only: PR validation must never create
      // a real unlocked package version (that only happens on push to main,
      // via the `build` action) — concurrent PRs would otherwise race for
      // conflicting build numbers.
      unlocked: mode === 'org' ? {sourceOnly: true} : undefined,
      validation: mode,
    },
    logger,
    localValidator,
  );

  const renderer = new ActionsProgressRenderer(logger);
  renderer.attachToBuildOrchestrator(orchestrator.buildBus, orchestrator.orchestrationBus);

  const tracer = createTracer({serviceName: 'sfpm-actions'});
  tracer.subscribe({build: orchestrator.buildBus, orchestration: orchestrator.orchestrationBus});

  const orchResult = await orchestrator.buildAll(packageNames);

  // ------------------------------------------------------------------
  // 4. Resolve pending deploy validations ('org' mode only)
  // ------------------------------------------------------------------
  const validationResults = mode === 'org'
    ? await resolvePendingValidations(orchResult.results, projectConfig, projectGraph, logger)
    : new Map<string, PendingValidationOutcome>();

  renderer.printSummary();
  await tracer.shutdown();

  // ------------------------------------------------------------------
  // 5. Set outputs and return result
  // ------------------------------------------------------------------
  const duration = Date.now() - startTime;
  const packages = orchResult.results.map(r => {
    const validation = validationResults.get(r.packageName);
    return {
      coveragePercentage: validation?.testCoverage,
      error: validation?.status === 'failed' ? validation.error : r.error,
      packageName: r.packageName,
      skipped: r.skipped,
      success: r.success && validation?.status !== 'failed',
    };
  });

  const success = orchResult.success && packages.every(p => p.success || p.skipped);

  const result: ValidatePrResult = {
    cacheHit,
    duration,
    orgId: connection?.orgId ?? '',
    packages,
    prNumber,
    success,
    username: connection?.username ?? '',
  };

  setActionOutputs(result);

  if (success) {
    logger.info(`PR #${prNumber} validation passed in ${Math.round(duration / 1000)}s`);
  } else {
    const failed = packages.filter(p => !p.success && !p.skipped).map(p => p.packageName).join(', ');
    core.setFailed(`Validation failed for: ${failed}`);
  }

  return result;
}

// ============================================================================
// Changed-package detection (default when `packages` is not specified)
// ============================================================================

/**
 * Resolves the PR base ref to diff against: explicit `baseRef` option, else
 * the PR's base SHA from the GitHub Actions event context.
 */
export function resolveBaseRef(options: ValidatePrOptions): string | undefined {
  return options.baseRef ?? github.context.payload.pull_request?.base?.sha;
}

/**
 * Resolves the packages to validate when none are explicitly specified:
 * only packages changed against `baseRef`. Falls back to all packages if no
 * base ref is available, or if the git diff fails (e.g. shallow checkout —
 * requires `fetch-depth: 0` or fetching the PR base ref).
 */
async function resolveChangedPackageNames(
  projectConfig: ProjectDefinitionProvider,
  options: ValidatePrOptions,
  logger: GitHubActionsLogger,
): Promise<string[]> {
  const allPackageNames = projectConfig.getAllPackageNames();
  const baseRef = resolveBaseRef(options);

  if (!baseRef) {
    logger.warn('No base ref available to detect changed packages; validating all packages.');
    return allPackageNames;
  }

  try {
    const gitService = await GitService.initialize(projectConfig.projectDir, logger);
    const definitions = projectConfig.getAllPackageDefinitions();
    const pathToName = new Map(definitions.map(def => [def.path, def.name]));

    const changedPaths = await gitService.getChangedPackagePaths(baseRef, definitions.map(def => def.path));

    return changedPaths.map(p => pathToName.get(p))
    .filter(Boolean);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.warn(`Failed to detect changed packages against "${baseRef}" (${message}); validating all packages. Ensure the checkout step uses fetch-depth: 0 (or otherwise fetches the PR base ref).`);
    return allPackageNames;
  }
}

// ============================================================================
// Pool config resolution
// ============================================================================

/**
 * Resolves the pool type for `poolTag`, preferring (in order): the explicit
 * `poolType` option, `sfpm.config.ts` orgs.pools[tag].type, then 'scratch'.
 */
export function resolvePoolType(sfpmConfig: SfpmConfig, poolTag: string | undefined, explicitType: OrgTypes | undefined): OrgTypes {
  const poolConfig = (sfpmConfig.orgs as undefined | {[tag: string]: {type?: OrgTypes}})?.[poolTag ?? ''];
  return explicitType ?? poolConfig?.type ?? OrgTypes.Scratch;
}

// ============================================================================
// Scratch org resolution ('org' mode)
// ============================================================================

async function resolveScratchOrg(
  mode: 'local' | 'org',
  options: ValidatePrOptions,
  poolType: OrgTypes,
  prNumber: number,
  logger: GitHubActionsLogger,
): Promise<{cacheHit: boolean; connection?: CachedOrgConnection; scratchOrg?: Org}> {
  if (mode !== 'org') {
    return {cacheHit: false};
  }

  if (!options.poolTag) {
    throw new Error('poolTag is required when mode is "org"');
  }

  if (!options.devhubUsername) {
    throw new Error('devhubUsername is required when mode is "org"');
  }

  logger.info(`Pool tag: ${options.poolTag}`);

  const {cacheHit, connection} = await resolveOrg(options.poolTag, poolType, options, prNumber, logger);

  logger.info(`Authenticating to ${connection.username}...`);
  await authenticateOrg(connection, options.devhubUsername, logger);

  const scratchOrg = await Org.create({aliasOrUsername: connection.username});

  return {cacheHit, connection, scratchOrg};
}

// ============================================================================
// Local nimbus validator (compile + dependency checks, both modes)
// ============================================================================

function createLocalValidator(projectConfig: ProjectDefinitionProvider, logger: GitHubActionsLogger): NimbusLocalValidator {
  const manifests = projectConfig.getAllPackageDefinitions().map(def => ({
    declaredDependencies: new Set(projectConfig.getDependencies(def.name).map(d => d.name)),
    packageId: def.name,
    packagePath: path.join(projectConfig.projectDir, def.path),
  }));

  return new NimbusLocalValidator(
    {
      config: {daemon: {autoStart: false, autoStop: true, enabled: false}},
      eventBus: new NimbusValidationEventBus(),
      logger,
    },
    manifests,
  );
}

// ============================================================================
// Pending deploy validation resolution ('org' mode)
// ============================================================================

async function resolvePendingValidations(
  results: Array<PackageResult<PendingValidationDescriptor>>,
  projectConfig: ProjectDefinitionProvider,
  projectGraph: ProjectGraph,
  logger: GitHubActionsLogger,
): Promise<Map<string, PendingValidationOutcome>> {
  const validationResults = new Map<string, PendingValidationOutcome>();

  const pending = results
  .map(r => r.result)
  .filter((r): r is PendingValidationDescriptor => r !== null && r !== undefined);

  if (pending.length === 0) {
    return validationResults;
  }

  const validationBus = new ValidationEventBus();
  const resolver = new ValidationResolver(projectConfig, projectGraph, logger, validationBus);
  const resolved = await resolver.resolve(pending);
  for (const [packageName, state] of resolved) {
    validationResults.set(packageName, state);
  }

  return validationResults;
}

// ============================================================================
// Org resolution (cache → pool fallback)
// ============================================================================

async function resolveOrg(
  poolTag: string,
  poolType: OrgTypes,
  options: ValidatePrOptions,
  prNumber: number,
  logger: GitHubActionsLogger,
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
  const org = await fetchOrgFromPool(poolTag, poolType, options, logger);

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
  poolTag: string,
  poolType: OrgTypes,
  options: ValidatePrOptions,
  logger: GitHubActionsLogger,
): Promise<PoolOrg> {
  logger.group('Pool Fetch');

  const devhub = await Org.create({aliasOrUsername: options.devhubUsername!});
  const {authenticator, fetcher} = createPoolServices({devhub, logger, poolType});

  const renderer = new ActionsProgressRenderer(logger);
  renderer.attachToPoolFetcher(fetcher);

  const org = await fetcher.fetch(poolTag, {
    postClaimActions: [org => authenticator.login(org)],
  });

  logger.info(`Fetched org: ${org.auth.username} (${org.orgId})`);
  logger.groupEnd();

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
  logger: GitHubActionsLogger,
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
