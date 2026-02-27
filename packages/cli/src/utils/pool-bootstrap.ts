import type {Logger} from '@b64/sfpm-core';

import {
  createPoolServices as createPoolServicesFromOrg,
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
 * Resolves the DevHub org and delegates to the shared
 * `createPoolServices()` factory from `@b64/sfpm-orgs`.
 */
export async function createPoolServices(options: {
  devhub: string;
  logger?: Logger;
  tasks?: PoolOrgTask[];
}): Promise<PoolServices> {
  const hubOrg = await Org.create({aliasOrUsername: options.devhub});

  return createPoolServicesFromOrg({
    hubOrg,
    logger: options.logger,
    tasks: options.tasks,
  });
}
