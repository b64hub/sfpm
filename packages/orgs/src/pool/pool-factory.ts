import type {Logger} from '@b64/sfpm-core';

import {Org, OrgTypes} from '@salesforce/core';

import type {OrgProvider} from '../org/org-provider.js';
import type {
  PoolOrgTask,
} from './types.js';

import SandboxProvider from '../org/sandbox/sandbox-provider.js';
import ScratchOrgProvider from '../org/scratch/scratch-org-provider.js';
import AuthService from '../org/services/auth-service.js';
import DevHubService from '../org/services/devhub-service.js';
import PoolFetcher from './pool-fetcher.js';
import PoolManager from './pool-manager.js';

/**
 * Result from `createPoolServices()`. Provides the wired-up pool
 * collaborators ready for use.
 */
export interface PoolServices {
  /** The hub service for JWT config, email, and user lookups */
  devHub: DevHubService;
  /** Pool fetcher for claiming orgs */
  fetcher: PoolFetcher;
  /** Pool manager for provisioning and deleting orgs */
  manager: PoolManager;
}

/**
 * Options for `createPoolServices()`.
 */
export interface CreatePoolServicesOptions {
  /** The resolved Salesforce `Org` instance for the hub */
  hubOrg: Org;
  /** Logger shared across all services */
  logger?: Logger;
  /**
   * Pool type — determines which strategy is used.
   */
  poolType?: OrgTypes;
  /** Tasks to run on each provisioned org */
  tasks?: PoolOrgTask[];
}

/**
 * Bootstrap the full pool service stack from a resolved hub `Org`.
 *
 * Wires up the appropriate `OrgProvider` based on `poolType`,
 * along with the authenticator, `PoolManager`, and `PoolFetcher`.
 * Both the CLI and GitHub Actions packages use this factory to avoid
 * duplicate wiring.
 *
 * @example
 * ```ts
 * import { Org } from '@salesforce/core';
 * import { createPoolServices } from '@b64/sfpm-orgs';
 *
 * // Scratch org pool (default)
 * const hubOrg = await Org.create({ aliasOrUsername: 'my-devhub' });
 * const { manager, fetcher } = createPoolServices({ hubOrg });
 *
 * // Sandbox pool
 * const prodOrg = await Org.create({ aliasOrUsername: 'my-prod-org' });
 * const { manager: sbManager } = createPoolServices({
 *   hubOrg: prodOrg,
 *   poolType: 'sandbox',
 * });
 * ```
 */
export function createPoolServices(options: CreatePoolServicesOptions): PoolServices {
  const {hubOrg, logger, poolType = 'scratchOrg', tasks} = options;

  if (!hubOrg.getUsername()) {
    throw new Error('Hub org must be authenticated and have a username');
  }

  const devHub = new DevHubService(hubOrg, logger);

  const provider: OrgProvider = poolType === OrgTypes.Sandbox
    ? new SandboxProvider(hubOrg)
    : new ScratchOrgProvider(hubOrg);

  const jwtConfig = devHub.getJwtConfig();
  const authenticator = new AuthService(
    hubOrg.getUsername()!,
    jwtConfig.clientId ? jwtConfig : undefined,
  );

  const manager = new PoolManager({
    logger,
    provider,
    tasks,
  });

  const fetcher = new PoolFetcher(provider, authenticator, logger);

  return {
    devHub, fetcher, manager,
  };
}
