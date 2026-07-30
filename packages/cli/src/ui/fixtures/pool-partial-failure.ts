/**
 * Pool fill — partial failure fixture.
 *
 * 5 orgs: org-3 fails during creation (no row appears), org-4 completes
 * deployment but with 2 package failures (warning state), org-5 fails
 * mid-task. The rest succeed cleanly.
 *
 * Exercises: creation failure counter, warning state, task failure,
 * and the done/warning/failed summary rollup.
 */

type Event = Record<string, unknown> & {type: string};

const PACKAGES = [
  {name: '@myorg/core-lib',       version: '1.5.0'},
  {name: '@myorg/data-access',    version: '2.1.0'},
  {name: '@myorg/ui-components',  version: '0.9.3'},
  {name: '@myorg/api-gateway',    version: '3.0.1'},
  {name: '@myorg/auth-service',   version: '1.2.0'},
];

const ORGS = [
  {alias: 'dev-pool-1', username: 'test-org-1@scratch.salesforce.com'},
  {alias: 'dev-pool-2', username: 'test-org-2@scratch.salesforce.com'},
  // org-3 never appears — fails during creation
  {alias: 'dev-pool-4', username: 'test-org-4@scratch.salesforce.com'},
  {alias: 'dev-pool-5', username: 'test-org-5@scratch.salesforce.com'},
];

function orgPackagesAllGood(username: string): Event[] {
  return PACKAGES.flatMap(pkg => [
    {
      packageName: pkg.name, total: PACKAGES.length, type: 'org:pkg:start', username,
    },
    {
      packageName: pkg.name, success: true, type: 'org:pkg:done', username, version: pkg.version,
    },
  ]);
}

/** Org-4: first 3 succeed, last 2 fail (continueOnError=true → warning) */
function orgPackagesPartial(username: string): Event[] {
  const events: Event[] = [];
  for (const [i, pkg] of PACKAGES.entries()) {
    events.push({
      packageName: pkg.name, total: PACKAGES.length, type: 'org:pkg:start', username,
    }, {
      packageName: pkg.name, success: i < 3, type: 'org:pkg:done', username, version: pkg.version,
    });
  }

  return events;
}

export const poolPartialFailureEvents: Event[] = [
  // ── Provision starts ────────────────────────────────────────────────────────
  {tag: 'dev-pool', total: 5, type: 'pool:start'},

  // ── Org creation ───────────────────────────────────────────────────────────
  {alias: ORGS[0].alias, type: 'org:appeared', username: ORGS[0].username},
  {alias: ORGS[1].alias, type: 'org:appeared', username: ORGS[1].username},

  // org-3 fails during creation — no row, just a counter bump
  {type: 'pool:creation:failed'},

  {alias: ORGS[2].alias, type: 'org:appeared', username: ORGS[2].username},
  {alias: ORGS[3].alias, type: 'org:appeared', username: ORGS[3].username},

  // ── Prerequisites ──────────────────────────────────────────────────────────
  {type: 'org:prereqs', username: ORGS[0].username},
  {type: 'org:prereqs', username: ORGS[1].username},
  {type: 'org:prereqs', username: ORGS[2].username},
  {type: 'org:prereqs', username: ORGS[3].username},

  // ── Deployment ────────────────────────────────────────────────────────────
  {type: 'org:deploying', username: ORGS[0].username},
  {type: 'org:deploying', username: ORGS[1].username},
  {type: 'org:deploying', username: ORGS[2].username},
  {type: 'org:deploying', username: ORGS[3].username},

  // Org-5 fails mid-task (deploy never completes)
  {type: 'org:failed', username: ORGS[3].username},

  ...orgPackagesAllGood(ORGS[0].username),
  ...orgPackagesAllGood(ORGS[1].username),
  ...orgPackagesPartial(ORGS[2].username),  // partial success → warning

  // ── Terminal states ────────────────────────────────────────────────────────
  {type: 'org:done', username: ORGS[0].username},
  {type: 'org:done', username: ORGS[1].username},
  {type: 'org:done', username: ORGS[2].username},  // warning (failedPackages > 0)

  {type: 'pool:done'},
];
