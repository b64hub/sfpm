import * as core from '@actions/core';
import {
  createPoolServices,
  type PoolConfig,
  type PoolProvisionResult,
  type SandboxLicenseType,
} from '@b64/sfpm-orgs';
import {Org, OrgTypes} from '@salesforce/core';

import {createGitHubActionsLogger} from './logger.js';
import {ActionsProgressRenderer} from './progress-renderer.js';

// ============================================================================
// Types
// ============================================================================

export interface ProvisionPoolOptions {
  /** Max concurrent org creations (default: 5) */
  batchSize?: number;
  /** Scratch org definition file path */
  definitionFile?: string;
  /** DevHub username or alias */
  devhubUsername: string;
  /** Scratch org expiry in days (default: 7) */
  expiryDays?: number;
  /** Sandbox activation user group name */
  groupName?: string;
  /** Sandbox license type (default: DEVELOPER) */
  licenseType?: SandboxLicenseType;
  /** Maximum number of orgs to allocate */
  maxAllocation: number;
  /** Pool type: scratchOrg or sandbox */
  poolType?: OrgTypes;
  /** Sandbox name prefix (e.g., SB → SB1, SB2, ...) */
  sandboxNamePattern?: string;
  /** Source sandbox name to clone from */
  sourceSandboxName?: string;
  /** Pool tag */
  tag: string;
}

export interface ProvisionPoolResult {
  /** Duration in milliseconds */
  duration: number;
  /** Error messages from failed provisioning attempts */
  errors: string[];
  /** Number of orgs that failed to provision */
  failed: number;
  /** Number of orgs that succeeded */
  succeeded: number;
  /** Whether all orgs were provisioned successfully */
  success: boolean;
  /** The pool tag */
  tag: string;
}

// ============================================================================
// Pool Provisioning
// ============================================================================

/**
 * Main entry point for the pool provisioning GitHub Action.
 *
 * Workflow:
 * 1. Connect to the DevHub org
 * 2. Validate hub prerequisites
 * 3. Build pool configuration
 * 4. Provision orgs via PoolManager
 * 5. Report results via GitHub Actions outputs
 */
export async function provisionPool(options: ProvisionPoolOptions): Promise<ProvisionPoolResult> {
  const logger = createGitHubActionsLogger({prefix: 'provision-pool'});
  const startTime = Date.now();
  const poolType = options.poolType ?? OrgTypes.Scratch;

  logger.info(`Pool tag: ${options.tag}`);
  logger.info(`Pool type: ${poolType}`);
  logger.info(`Max allocation: ${options.maxAllocation}`);
  logger.info(`DevHub: ${options.devhubUsername}`);

  // ------------------------------------------------------------------
  // 1. Connect to DevHub
  // ------------------------------------------------------------------
  logger.info('Connecting to hub org...');
  const devhub = await Org.create({aliasOrUsername: options.devhubUsername});

  const {manager} = createPoolServices({
    devhub,
    logger,
    poolType,
  });

  logger.info('Connected to hub org');

  // ------------------------------------------------------------------
  // 2. Attach progress renderer
  // ------------------------------------------------------------------
  const renderer = new ActionsProgressRenderer(logger);
  renderer.attachToManager(manager);

  // ------------------------------------------------------------------
  // 3. Validate prerequisites
  // ------------------------------------------------------------------
  logger.info('Validating hub prerequisites...');
  await manager.validatePrerequisites();
  logger.info('Hub prerequisites validated');

  // ------------------------------------------------------------------
  // 4. Build config and provision
  // ------------------------------------------------------------------
  const config = buildPoolConfig(options, poolType);
  const provisionResult = await manager.provision(config);

  renderer.printSummary();

  // ------------------------------------------------------------------
  // 5. Set outputs and return result
  // ------------------------------------------------------------------
  const duration = Date.now() - startTime;
  const result: ProvisionPoolResult = {
    duration,
    errors: provisionResult.errors,
    failed: provisionResult.failed,
    succeeded: provisionResult.succeeded.length,
    success: provisionResult.failed === 0,
    tag: provisionResult.tag,
  };

  setActionOutputs(result, provisionResult);

  if (result.success) {
    logger.info(`Pool "${options.tag}" provisioned ${result.succeeded} org(s) in ${Math.round(duration / 1000)}s`);
  } else if (result.succeeded > 0) {
    core.warning(`Pool provisioning partially failed: ${result.succeeded} succeeded, ${result.failed} failed`);
  } else {
    core.setFailed(`Pool provisioning failed: ${provisionResult.errors.join(', ')}`);
  }

  return result;
}

// ============================================================================
// Helpers
// ============================================================================

function buildPoolConfig(options: ProvisionPoolOptions, poolType: OrgTypes): PoolConfig {
  const sizing = {
    batchSize: options.batchSize,
    maxAllocation: options.maxAllocation,
  };

  if (poolType === OrgTypes.Sandbox) {
    return {
      sandbox: {
        groupName: options.groupName,
        licenseType: options.licenseType ?? 'DEVELOPER',
        namePattern: options.sandboxNamePattern ?? 'SB',
        sourceSandboxName: options.sourceSandboxName,
      },
      sizing,
      tag: options.tag,
      type: OrgTypes.Sandbox,
    };
  }

  if (!options.definitionFile) {
    throw new Error('--definition-file is required for scratch org pools');
  }

  return {
    scratchOrg: {
      definitionFile: options.definitionFile,
      expiryDays: options.expiryDays,
    },
    sizing,
    tag: options.tag,
    type: OrgTypes.Scratch,
  };
}

function setActionOutputs(result: ProvisionPoolResult, provisionResult: PoolProvisionResult): void {
  core.setOutput('success', String(result.success));
  core.setOutput('tag', result.tag);
  core.setOutput('succeeded', String(result.succeeded));
  core.setOutput('failed', String(result.failed));
  core.setOutput('duration', String(result.duration));
  core.setOutput('result', JSON.stringify(result));
  core.setOutput('org-usernames', provisionResult.succeeded.map(o => o.auth.username).join(','));
}
