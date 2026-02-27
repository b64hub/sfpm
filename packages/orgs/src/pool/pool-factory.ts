import type {Logger} from '@b64/sfpm-core';

import type {Org} from '@salesforce/core';

import DevHubService from '../org/services/devhub-service.js';
import OrgService from '../org/org-service.js';
import ScratchOrgAuthService from '../org/services/scratch-org-auth-service.js';
import PoolFetcher from './pool-fetcher.js';
import PoolManager from './pool-manager.js';
import type {
  PoolOrgTask,
} from './types.js';

// ============================================================================
// Pool Factory
// ============================================================================

/**
 * Result from `createPoolServices()`. Provides the wired-up pool
 * collaborators ready for use.
 */
export interface PoolServices {
  /** The DevHub adapter (also implements `PoolOrgProvider`) */
  devHub: DevHubService;
  /** Pool fetcher for claiming scratch orgs */
  fetcher: PoolFetcher;
  /** Pool manager for provisioning and deleting scratch orgs */
  manager: PoolManager;
  /** Org service for scratch org lifecycle operations */
  orgService: OrgService;
}

/**
 * Options for `createPoolServices()`.
 */
export interface CreatePoolServicesOptions {
  /** The resolved Salesforce `Org` instance for the DevHub */
  hubOrg: Org;
  /** Logger shared across all services */
  logger?: Logger;
  /** Tasks to run on each provisioned org */
  tasks?: PoolOrgTask[];
}

/**
 * Bootstrap the full pool service stack from a resolved DevHub `Org`.
 *
 * Wires up `DevHubService`, `OrgService`, `ScratchOrgAuthService`,
 * `PoolManager`, and `PoolFetcher` with proper dependency injection.
 * Both the CLI and GitHub Actions packages use this factory to avoid
 * duplicate wiring.
 *
 * @example
 * ```ts
 * import { Org } from '@salesforce/core';
 * import { createPoolServices } from '@b64/sfpm-orgs';
 *
 * const hubOrg = await Org.create({ aliasOrUsername: 'my-devhub' });
 * const { manager, fetcher } = createPoolServices({ hubOrg });
 *
 * // Provision a pool
 * const result = await manager.provision(poolConfig);
 *
 * // Fetch an org
 * const org = await fetcher.fetch({ tag: 'dev-pool' });
 * ```
 */
export function createPoolServices(options: CreatePoolServicesOptions): PoolServices {
  const devHub = new DevHubService(options.hubOrg);
  const orgService = new OrgService(devHub, options.logger);

  const jwtConfig = devHub.getJwtConfig();
  const auth = jwtConfig.clientId
    ? new ScratchOrgAuthService(devHub.getUsername(), jwtConfig)
    : undefined;

  const manager = new PoolManager({
    logger: options.logger,
    orgService,
    poolOrgProvider: devHub,
    tasks: options.tasks,
  });

  const fetcher = new PoolFetcher(devHub, auth, options.logger);

  return {
    devHub, fetcher, manager, orgService,
  };
}


