import type {PoolOrg, PoolOrgInfo} from '@b64hub/sfpm-orgs';

import {OrgTypes} from '@salesforce/core';

type Stage = PoolOrgInfo['stage'];

const DAY = 86_400_000;

/**
 * Fake pool orgs for dev pool-list-replay.
 * Covers all stages, both org types, and an expired org.
 */
export const poolListFixture: PoolOrg[] = [
  {
    auth: {alias: 'dev-pool-1', loginUrl: 'https://login.salesforce.com', username: 'test-org-1@scratch.salesforce.com'},
    expiry: Date.now() + (7 * DAY),
    orgId: 'org-001',
    orgType: OrgTypes.Scratch,
    pool: {stage: 'Available' as Stage, tag: 'dev-pool', timestamp: Date.now()},
  },
  {
    auth: {alias: 'dev-pool-2', loginUrl: 'https://login.salesforce.com', username: 'test-org-2@scratch.salesforce.com'},
    expiry: Date.now() + (3 * DAY),
    orgId: 'org-002',
    orgType: OrgTypes.Scratch,
    pool: {stage: 'Available' as Stage, tag: 'dev-pool', timestamp: Date.now()},
  },
  {
    auth: {alias: 'dev-pool-3', loginUrl: 'https://login.salesforce.com', username: 'test-org-3@scratch.salesforce.com'},
    expiry: Date.now() + (5 * DAY),
    orgId: 'org-003',
    orgType: OrgTypes.Scratch,
    pool: {stage: 'InProgress' as Stage, tag: 'dev-pool', timestamp: Date.now()},
  },
  {
    auth: {alias: 'sb-pool-1', loginUrl: 'https://login.salesforce.com', username: 'test-sb-1@sandbox.salesforce.com'},
    expiry: Date.now() - (2 * DAY),
    orgId: 'org-004',
    orgType: OrgTypes.Sandbox,
    pool: {stage: 'Assigned' as Stage, tag: 'sb-pool', timestamp: Date.now()},
  },
  {
    auth: {username: 'test-org-5@scratch.salesforce.com'},
    expiry: Date.now() + DAY,
    orgId: 'org-005',
    orgType: OrgTypes.Scratch,
    pool: {stage: 'InProgress' as Stage, tag: 'dev-pool', timestamp: Date.now()},
  },
];
