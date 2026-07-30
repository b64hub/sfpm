import type {PoolOrg} from '@b64hub/sfpm-orgs';

import {Box, Text, useApp} from 'ink';
import {useEffect} from 'react';

import {PackageRow} from '../components/PackageRow.js';
import {Divider} from '../components/base/Divider.js';
import {OrgBadge} from '../components/base/OrgBadge.js';
import {useTermWidth} from '../hooks/use-term-width.js';
import {POOL_ORG_COLS, PoolOrgRow} from '../components/pool/PoolOrgRow.js';

interface PoolListAppProps {
  devhubAlias: string;
  orgs: PoolOrg[];
  tag?: string;
}

/**
 * Static Ink app for `pool list`.
 *
 * Data is fully available at mount time — no bus, no reducer.
 * Renders once then calls exit() so control returns to the shell.
 */
export function PoolListApp({devhubAlias, orgs, tag}: PoolListAppProps) {
  const {exit} = useApp();
  const termWidth = useTermWidth();

  // Render once then hand control back to the terminal.
  useEffect(() => { exit(); }, [exit]);

  const header = tag
    ? `${orgs.length} org${orgs.length !== 1 ? 's' : ''} in ${tag}`
    : `${orgs.length} org${orgs.length !== 1 ? 's' : ''}`;

  return (
    <Box flexDirection="column">

      <OrgBadge alias={devhubAlias} />
      <Divider width={termWidth} />

      {orgs.length === 0
        ? <Text dimColor>No orgs found{tag ? ` in pool "${tag}"` : ''}.</Text>
        : (
          <>
            {/* Column header */}
            <PackageRow
              width={termWidth}
              props={{
                columns:  <PackageRow.MetaCols cols={POOL_ORG_COLS} header />,
                icon:     <Text> </Text>,
                id:       '__header__',
                primary:  'alias',
                secondary: <PackageRow.Secondary>username</PackageRow.Secondary>,
              }}
            />
            <Divider width={termWidth} />

            {/* Org rows */}
            {orgs.map(org => (
              <PoolOrgRow key={org.orgId} org={org} width={termWidth} />
            ))}
          </>
        )
      }

      <Box marginTop={1}>
        <Text dimColor>{header}</Text>
      </Box>

    </Box>
  );
}
