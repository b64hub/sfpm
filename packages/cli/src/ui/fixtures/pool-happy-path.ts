/**
 * Pool fill — happy path fixture.
 *
 * 4 scratch orgs provisioned, 6 packages each, all succeed.
 * Exercises: creation phase, prereqs, deploy progress, done rollup.
 *
 * Events are in the uiBus vocabulary (post-bridge), so this can be
 * replayed directly against PoolFillApp without a PoolManager.
 */

type Event = Record<string, unknown> & {type: string};

const PACKAGES = [
  {name: '@myorg/core-lib',       version: '1.5.0'},
  {name: '@myorg/data-access',    version: '2.1.0'},
  {name: '@myorg/ui-components',  version: '0.9.3'},
  {name: '@myorg/api-gateway',    version: '3.0.1'},
  {name: '@myorg/auth-service',   version: '1.2.0'},
  {name: '@myorg/app-shell',      version: '4.1.0'},
];

const ORGS = [
  {alias: 'dev-pool-1', username: 'test-org-1@scratch.salesforce.com'},
  {alias: 'dev-pool-2', username: 'test-org-2@scratch.salesforce.com'},
  {alias: 'dev-pool-3', username: 'test-org-3@scratch.salesforce.com'},
  {alias: 'dev-pool-4', username: 'test-org-4@scratch.salesforce.com'},
];

/** Emit package install progress for one org (all packages, sequential). */
function orgPackages(username: string): Event[] {
  const events: Event[] = [];
  for (const pkg of PACKAGES) {
    events.push(
      {
        packageName: pkg.name, total: PACKAGES.length, type: 'org:pkg:start', username,
      },
      {
        packageName: pkg.name, success: true, type: 'org:pkg:done', username, version: pkg.version,
      },
    );
  }

  return events;
}

export const poolHappyPathEvents: Event[] = [
  // ── Provision starts ────────────────────────────────────────────────────────
  {tag: 'dev-pool', total: 4, type: 'pool:start'},

  // ── Org creation (staggered) ────────────────────────────────────────────────
  {
    alias: ORGS[0].alias, tag: 'dev-pool', type: 'org:appeared', username: ORGS[0].username,
  },
  {
    alias: ORGS[1].alias, tag: 'dev-pool', type: 'org:appeared', username: ORGS[1].username,
  },
  {
    alias: ORGS[2].alias, tag: 'dev-pool', type: 'org:appeared', username: ORGS[2].username,
  },
  {
    alias: ORGS[3].alias, tag: 'dev-pool', type: 'org:appeared', username: ORGS[3].username,
  },

  // ── Prerequisites (sfpm-artifact package) ──────────────────────────────────
  {type: 'org:prereqs', username: ORGS[0].username},
  {type: 'org:prereqs', username: ORGS[1].username},
  {type: 'org:prereqs', username: ORGS[2].username},
  {type: 'org:prereqs', username: ORGS[3].username},

  // ── Deployment phase ───────────────────────────────────────────────────────
  {type: 'org:deploying', username: ORGS[0].username},
  {type: 'org:deploying', username: ORGS[1].username},

  // Org 0 and Org 1 start installing in parallel
  ...orgPackages(ORGS[0].username),

  {type: 'org:deploying', username: ORGS[2].username},

  ...orgPackages(ORGS[1].username),

  {type: 'org:deploying', username: ORGS[3].username},

  ...orgPackages(ORGS[2].username),
  ...orgPackages(ORGS[3].username),

  // ── Done ──────────────────────────────────────────────────────────────────
  {type: 'org:done', username: ORGS[0].username},
  {type: 'org:done', username: ORGS[1].username},
  {type: 'org:done', username: ORGS[2].username},
  {type: 'org:done', username: ORGS[3].username},

  {tag: 'dev-pool', type: 'pool:done'},
];
