import type {Logger} from '@b64/sfpm-core';

import {
  DevHubService,
  OrgService,
  PoolFetcher,
  PoolManager,
  type PoolManagerOptions,
  type PoolOrgTask,
  PoolService,
  ScratchOrgAuthService,
} from '@b64/sfpm-orgs';
import {Org} from '@salesforce/core';

// ============================================================================
// DevHub Bootstrap
// ============================================================================

/**
 * Bootstrap the full pool service stack from a DevHub alias or username.
 *
 * Resolves the DevHub org, creates the DevHubService adapter, and wires
 * up all collaborators needed for pool operations.
 */
export async function createPoolServices(options: {
  devhub: string;
  logger?: Logger;
  tasks?: PoolOrgTask[];
}): Promise<{
  devHub: DevHubService;
  fetcher: PoolFetcher;
  manager: PoolManager;
  orgService: OrgService;
  poolService: PoolService;
}> {
  const hubOrg = await Org.create({aliasOrUsername: options.devhub});
  const devHub = new DevHubService(hubOrg);
  const orgService = new OrgService(devHub, options.logger);

  const auth = new ScratchOrgAuthService(
    devHub.getUsername(),
    devHub.getJwtConfig(),
  );

  const managerOptions: PoolManagerOptions = {
    logger: options.logger,
    orgService,
    poolOrgProvider: devHub,
    tasks: options.tasks,
  };

  const manager = new PoolManager(managerOptions);
  const fetcher = new PoolFetcher(devHub, orgService, auth, options.logger);
  const poolService = new PoolService(manager, fetcher, devHub, options.logger);

  return {
    devHub, fetcher, manager, orgService, poolService,
  };
}
