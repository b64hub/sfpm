import * as core from '@actions/core';
import {loadSfpmConfig} from '@b64hub/sfpm-core';
import {
  ArtifactPackageInstallTask,
  createPoolServices,
  DeploymentTask,
  type PoolConfig,
  type PoolOrgTask,
} from '@b64hub/sfpm-orgs';
import {Org, OrgTypes} from '@salesforce/core';
import path from 'node:path';

import {createGitHubActionsLogger} from './logger.js';
import {ActionsProgressRenderer} from './progress-renderer.js';

// ============================================================================
// Types
// ============================================================================

export interface FillPoolOptions {
  /** Max concurrent org creations (default: 5) */
  batchSize?: number;
  /** Org definition file path (scratch org or sandbox) */
  definitionFile?: string;
  /** DevHub username or alias */
  devhubUsername: string;
  /** Scratch org expiry in days (default: 7) */
  expiryDays?: number;
  /** Maximum number of orgs to allocate */
  maxAllocation?: number;
  /** Pool type: scratch or sandbox */
  poolType?: OrgTypes;
  /** Absolute path to the project root (default: GITHUB_WORKSPACE or cwd) */
  projectDir?: string;
  /** Sandbox name prefix (e.g., SB → SB1, SB2, ...) */
  sandboxNamePattern?: string;
  /** Pool tag(s) — pass an array to provision multiple pools in one run */
  tag: string | string[];
  /** Deploy from local project source instead of downloaded artifacts */
  useLocalSource?: boolean;
}

export interface FillPoolResult {
  /** Duration in milliseconds */
  duration: number;
  /** Error messages from failed provisioning attempts */
  errors: string[];
  /** Number of orgs that failed to provision */
  failed: number;
  /** Usernames of successfully provisioned orgs */
  orgUsernames: string[];
  /** Number of orgs that succeeded */
  succeeded: number;
  /** Whether all orgs were provisioned successfully */
  success: boolean;
  /** The pool tag */
  tag: string;
}

export interface FillPoolReport {
  /** Total duration across all pools, in milliseconds */
  duration: number;
  /** Per-pool provisioning results */
  results: FillPoolResult[];
  /** Whether every pool was provisioned successfully */
  success: boolean;
}

// ============================================================================
// Pool Provisioning
// ============================================================================

/**
 * Main entry point for the pool provisioning GitHub Action.
 *
 * Workflow:
 * 1. Connect to the DevHub org
 * 2. Build pool config and provisioning tasks
 * 3. Validate hub prerequisites
 * 4. Provision orgs via PoolManager (creates orgs, then runs tasks — e.g.
 *    installing the artifact-tracking package and deploying project
 *    packages — on each before marking it Available)
 * 5. Report results via GitHub Actions outputs
 */
export async function fillPool(options: FillPoolOptions): Promise<FillPoolReport> {
  const logger = createGitHubActionsLogger({prefix: 'fill-pool'});
  const startTime = Date.now();
  const projectDir = options.projectDir ?? process.env.GITHUB_WORKSPACE ?? process.cwd();
  const sfpmConfig = await loadSfpmConfig(projectDir, logger);
  const tags = Array.isArray(options.tag) ? options.tag : [options.tag];

  logger.info(`DevHub: ${options.devhubUsername}`);
  logger.info(`Max allocation: ${options.maxAllocation}`);

  // ------------------------------------------------------------------
  // 1. Connect to DevHub
  // ------------------------------------------------------------------
  logger.info('Connecting to hub org...');
  const devhub = await Org.create({aliasOrUsername: options.devhubUsername});
  logger.info('Connected to hub org');

  // ------------------------------------------------------------------
  // 2. Provision each pool in turn
  // ------------------------------------------------------------------
  const results: FillPoolResult[] = [];
  for (const tag of tags) {
    // eslint-disable-next-line no-await-in-loop -- pools are provisioned sequentially
    results.push(await fillOnePool({
      devhub, logger, options, projectDir, sfpmConfig, tag,
    }));
  }

  // ------------------------------------------------------------------
  // 3. Set outputs and return report
  // ------------------------------------------------------------------
  const report: FillPoolReport = {
    duration: Date.now() - startTime,
    results,
    success: results.every(r => r.success),
  };

  setActionOutputs(report);

  for (const result of results) {
    if (result.success) {
      logger.info(`Pool "${result.tag}" provisioned ${result.succeeded} org(s) in ${Math.round(result.duration / 1000)}s`);
    } else if (result.succeeded > 0) {
      core.warning(`Pool "${result.tag}" provisioning partially failed: ${result.succeeded} succeeded, ${result.failed} failed`);
    } else {
      core.error(`Pool "${result.tag}" provisioning failed: ${result.errors.join(', ')}`);
    }
  }

  if (!report.success) {
    core.setFailed(`Pool provisioning failed for: ${results.filter(r => !r.success).map(r => r.tag).join(', ')}`);
  }

  return report;
}

/**
 * Provision a single pool — connects tasks/config for one tag and runs it
 * through the pool manager. Extracted so `fillPool()` can loop over
 * multiple tags in one action run.
 */
async function fillOnePool(context: {
  devhub: Org;
  logger: ReturnType<typeof createGitHubActionsLogger>;
  options: FillPoolOptions;
  projectDir: string;
  sfpmConfig: Awaited<ReturnType<typeof loadSfpmConfig>>;
  tag: string;
}): Promise<FillPoolResult> {
  const {devhub, logger, options, projectDir, sfpmConfig, tag} = context;
  const poolConfig = (sfpmConfig.orgs as undefined | {[tag: string]: PoolConfig})?.[tag];
  const poolType = options.poolType ?? poolConfig?.type as OrgTypes | undefined ?? OrgTypes.Scratch;

  logger.info(`Pool tag: ${tag}`);
  logger.info(`Pool type: ${poolType}`);

  const config = buildPoolConfig({...options, tag}, poolType, projectDir, poolConfig);
  const tasks = buildTasks(config, devhub, projectDir, options.useLocalSource);

  const {manager} = createPoolServices({
    devhub,
    logger,
    poolType,
    tasks,
  });

  const renderer = new ActionsProgressRenderer(logger);
  renderer.attachToManager(manager.bus);

  logger.info('Validating hub prerequisites...');
  await manager.validatePrerequisites();
  logger.info('Hub prerequisites validated');

  const provisionResult = await manager.provision(tag, config);

  renderer.printSummary();

  return {
    duration: provisionResult.elapsedMs,
    errors: provisionResult.errors,
    failed: provisionResult.failed,
    orgUsernames: provisionResult.succeeded.map(o => o.auth.username).filter(Boolean),
    succeeded: provisionResult.succeeded.length,
    success: provisionResult.failed === 0,
    tag: provisionResult.tag,
  };
}

// ============================================================================
// Helpers
// ============================================================================

export function buildPoolConfig(options: FillPoolOptions, poolType: OrgTypes, projectDir: string, poolConfig?: PoolConfig): PoolConfig {
  // Workflow inputs take precedence over sfpm.config.ts pool config.
  const sizing = {
    batch: options.batchSize ?? poolConfig?.sizing?.batch,
    max: options.maxAllocation ?? poolConfig?.sizing?.max,
  };

  const definitionFile = options.definitionFile ?? poolConfig?.definitionFile;
  if (!definitionFile) {
    throw new Error('definition-file is required (or configure definitionFile in pool/scratch/sandbox config)');
  }

  if (!sizing.max) {
    throw new Error('max-allocation is required (or configure sizing.max in pool config)');
  }

  if (poolType === OrgTypes.Sandbox) {
    return {
      ...poolConfig,
      definitionFile: path.resolve(projectDir, definitionFile),
      namePattern: options.sandboxNamePattern ?? (poolConfig as undefined | {namePattern?: string})?.namePattern ?? 'SB',
      sizing,
      type: OrgTypes.Sandbox,
    } as PoolConfig;
  }

  return {
    ...poolConfig,
    definitionFile: path.resolve(projectDir, definitionFile),
    expiryDays: options.expiryDays ?? (poolConfig as undefined | {expiryDays?: number})?.expiryDays,
    sizing,
    type: OrgTypes.Scratch,
  } as PoolConfig;
}

function setActionOutputs(report: FillPoolReport): void {
  const succeeded = report.results.reduce((sum, r) => sum + r.succeeded, 0);
  const failed = report.results.reduce((sum, r) => sum + r.failed, 0);

  core.setOutput('success', String(report.success));
  core.setOutput('tag', report.results.map(r => r.tag).join(','));
  core.setOutput('succeeded', String(succeeded));
  core.setOutput('failed', String(failed));
  core.setOutput('duration', String(report.duration));
  core.setOutput('result', JSON.stringify(report));
  core.setOutput('org-usernames', report.results.flatMap(r => r.orgUsernames).join(','));
}

/**
 * Build the pool org tasks that run against each provisioned org before
 * it's marked Available — mirrors `PoolFill.buildTasks()` in the CLI so
 * both entry points deploy project packages to freshly provisioned orgs.
 */
function buildTasks(config: PoolConfig, devhub: Org, projectDir: string, useLocalSource?: boolean): PoolOrgTask[] {
  const tasks: PoolOrgTask[] = [];

  // Scratch orgs need the artifact tracking package installed first
  if (config.type === OrgTypes.Scratch) {
    tasks.push(new ArtifactPackageInstallTask({devhub}));
  }

  // Deploy packages to the provisioned org
  tasks.push(new DeploymentTask({
    continueOnError: config.deployment?.continueOnError ?? true,
    testLevel: config.deployment?.testLevel,
    useLocalSource,
    workingDirectory: projectDir,
  }));

  return tasks;
}
