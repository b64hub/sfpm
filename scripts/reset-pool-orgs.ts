#!/usr/bin/env node
/**
 * Resets ScratchOrgInfo records in a pool back to Available.
 *
 * Usage:
 *   npx tsx reset-pool-orgs.ts --tag <pool-tag> --alias <devhub-alias>
 *
 * For each matching record it:
 *   - Sets Stage__c → 'Available'
 *   - Copies Tag__c → Pool_Tag__c
 *   - Copies Auth_Url__c → SfdxAuthUrl__c
 *
 * Requires @salesforce/core in the project where you run this.
 */

import { Org } from '@salesforce/core';

// --- args -------------------------------------------------------------------

const args = process.argv.slice(2);
const flag = (name: string) => { const i = args.indexOf(name); return i !== -1 ? args[i + 1] : undefined; };

const tag   = flag('--tag');
const alias = flag('--alias');

if (!tag || !alias) {
  console.error('Usage: npx tsx reset-pool-orgs.ts --tag <pool-tag> --alias <devhub-alias>');
  process.exit(1);
}

// --- main ------------------------------------------------------------------

async function main() {
  const hubOrg = await Org.create({ aliasOrUsername: alias });
  const conn   = hubOrg.getConnection();

  const escaped = tag.replaceAll("'", "\\'");
  const query   = `SELECT Id, Tag__c, Auth_Url__c, SignupUsername
                   FROM ScratchOrgInfo
                   WHERE Tag__c = '${escaped}'
                   AND Status = 'Active'`;

  type Row = { Id: string; Tag__c: string; Auth_Url__c: string; SignupUsername: string };
  const { records } = await conn.query<Row>(query);

  if (records.length === 0) {
    console.log('No active ScratchOrgInfo records found for tag:', tag);
    return;
  }

  console.log(`Found ${records.length} record(s) — updating…`);

  const updates = records.map(r => ({
    Id:             r.Id,
    Stage__c:       'Available',   // eslint-disable-line camelcase
    Pool_Tag__c:    r.Tag__c,      // eslint-disable-line camelcase
    SfdxAuthUrl__c: r.Auth_Url__c, // eslint-disable-line camelcase
  }));

  const results = await conn.sobject('ScratchOrgInfo').update(updates);
  const arr     = Array.isArray(results) ? results : [results];

  let ok = 0, failed = 0;
  for (const [i, r] of arr.entries()) {
    if (r.success) {
      ok++;
      console.log(`  ✓ ${records[i].SignupUsername}`);
    } else {
      failed++;
      const errs = (r as { errors?: { message: string }[] }).errors?.map(e => e.message).join('; ') ?? 'unknown';
      console.error(`  ✗ ${records[i].SignupUsername}: ${errs}`);
    }
  }

  console.log(`\nDone. ${ok} updated, ${failed} failed.`);
}

main().catch(err => { console.error(err); process.exit(1); });
