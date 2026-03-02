import type {Logger} from '@b64/sfpm-core';
import type {Org} from '@salesforce/core';

import type {OrgProvider} from '../org/org-provider.js';
import type {OrgType} from '../org/pool-org.js';
import type {
  PoolOrgTask,
} from './types.js';

import SandboxProvider from '../org/sandbox/sandbox-provider.js';
import ScratchOrgProvider from '../org/scratch/scratch-org-provider.js';
import AuthService from '../org/services/auth-service.js';
import DevHubService from '../org/services/devhub-service.js';
import PoolFetcher from './pool-fetcher.js';
import PoolManager from './pool-manager.js';

// ============================================================================
// Pool Factory
// ============================================================================

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
  /** The selected org provider */
  provider: OrgProvider;
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
   *
   * - `'scratchOrg'` (default) — selects `ScratchOrgProvider` + JWT auth
   * - `'sandbox'` — selects `SandboxProvider` + auth URL auth
   */
  poolType?: OrgType;
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

  // Hub service for JWT config, email, and user lookups
  const devHub = new DevHubService(hubOrg, logger);

  // Select provider based on pool type
  const provider: OrgProvider = poolType === 'sandbox'
    ? new SandboxProvider(hubOrg)
    : new ScratchOrgProvider(hubOrg);

  // Create authenticator — always AuthService with auth URL primary, JWT fallback
  const jwtConfig = devHub.getJwtConfig();
  const authenticator = new AuthService(
    devHub.getUsername(),
    jwtConfig.clientId ? jwtConfig : undefined,
  );

  const manager = new PoolManager({
    logger,
    provider,
    tasks,
  });

  const fetcher = new PoolFetcher(provider, authenticator, logger);

  return {
    devHub, fetcher, manager, provider,
  };
}
