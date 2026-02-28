import type {Logger} from '@b64/sfpm-core';

import {
  createPoolServices as createPoolServicesFromOrg,
  type OrgKind,
  type PoolOrgTask,
  type PoolServices,
} from '@b64/sfpm-orgs';
import {Org} from '@salesforce/core';

// ============================================================================
// DevHub Bootstrap
// ============================================================================

/**
 * Bootstrap the full pool service stack from a DevHub alias or username.
 *
 * Resolves the hub org and delegates to the shared
 * `createPoolServices()` factory from `@b64/sfpm-orgs`.
 *
 * @param options.poolType - `'scratchOrg'` (default) or `'sandbox'`
 */
export async function createPoolServices(options: {
  devhub: string;
  logger?: Logger;
  poolType?: OrgKind;
  tasks?: PoolOrgTask[];
}): Promise<PoolServices> {
  const hubOrg = await Org.create({aliasOrUsername: options.devhub});

  return createPoolServicesFromOrg({
    hubOrg,
    logger: options.logger,
    poolType: options.poolType,
    tasks: options.tasks,
  });
}
