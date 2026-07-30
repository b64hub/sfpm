import type {PoolOrg} from '@b64hub/sfpm-orgs';
import type {ReactNode} from 'react';

import {Text} from 'ink';

import type {MetaColSpec, PackageRowProps} from '../PackageRow.js';

import {PackageRow} from '../PackageRow.js';
import {formatExpiry, formatStage, stageColor} from '../../pool-utils.js';

// ── Column spec ───────────────────────────────────────────────────────────────

/**
 * Fixed-width metadata columns for pool org rows.
 * Pass the same spec to both `<PoolOrgRow>` and the header row.
 */
export const POOL_ORG_COLS: MetaColSpec[] = [
  {key: 'stage',   label: 'stage',   width: 12},
  {key: 'type',    label: 'type',    width: 8},
  {key: 'expires', label: 'expires', width: 14},
];

// ── Row ───────────────────────────────────────────────────────────────────────

function orgToProps(org: PoolOrg): PackageRowProps {
  const stage = org.pool?.stage;
  const alias = org.auth.alias ?? org.auth.username;

  const secondary: ReactNode | undefined = org.auth.alias
    ? <PackageRow.Secondary>{org.auth.username}</PackageRow.Secondary>
    : undefined;

  return {
    columns: (
      <PackageRow.MetaCols
        cols={POOL_ORG_COLS}
        meta={{
          expires: org.expiry ? formatExpiry(org.expiry) : '—',
          stage:   formatStage(stage),
          type:    org.orgType,
        }}
      />
    ),
    icon:      <Text color={stageColor(stage)}>●</Text>,
    id:        org.orgId,
    primary:   alias,
    secondary,
  };
}

/**
 * A single pool org row using the PackageRow layout.
 *
 * Slots: icon (stage-coloured dot) · alias · username (dim) | stage · type · expires
 */
export function PoolOrgRow({org, width}: {org: PoolOrg; width: number}) {
  return <PackageRow props={orgToProps(org)} width={width} />;
}
