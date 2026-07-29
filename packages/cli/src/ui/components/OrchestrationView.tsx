import type {ReactNode} from 'react';

import {Box, Static, Text} from 'ink';
import {useStdout} from 'ink';

import type {TreeNode} from '../state/types.js';

import {deriveStatus} from '../state/selectors.js';
import {toRowProps} from '../state/adapters.js';
import {Divider} from './Divider.js';
import {COL_STATUS, COL_TIME, PackageRow} from './PackageRow.js';

// ---- domain mapping ----

const TERMINAL = new Set(['success', 'failed', 'skipped']);


// ---- static item discriminated union ----

/**
 * Static renders items exactly once, in array order, permanently above the
 * live area. Putting the header as item 0 ensures it always appears before
 * completed packages — you can't achieve this with two separate Static
 * components because Ink has no ordering guarantee between them.
 */
type StaticItem =
  | {kind: 'header'; totalPackages: number; totalLevels: number}
  | {kind: 'pkg';    node: TreeNode};

// ---- view constants ----

const QUEUE_VISIBLE = 3;

// ---- component ----

export function OrchestrationView({levels}: {levels: TreeNode[]}) {
  const {stdout} = useStdout();
  const termWidth = stdout?.columns ?? 80;

  const totalPackages = levels.reduce((n, l) => n + l.children.length, 0);

  const doneLevels   = levels.filter(l => TERMINAL.has(deriveStatus(l.children)));
  const activeLevels = levels.filter(l => !TERMINAL.has(deriveStatus(l.children)));
  const donePackages = doneLevels.flatMap(l => l.children);

  // Header is always item 0; completed packages append after it.
  // termWidth is captured from the closure when each item is first rendered —
  // correct for the vast majority of cases (terminal resize during a build is
  // an edge case Ink doesn't handle well regardless).
  const staticItems: StaticItem[] = [
    {kind: 'header', totalPackages, totalLevels: levels.length},
    ...donePackages.map((node): StaticItem => ({kind: 'pkg', node})),
  ];

  const currentIdx   = activeLevels.findIndex(l =>
    l.children.some(p => p.status === 'running' || p.status === 'failed'),
  );
  const currentLevel = activeLevels[currentIdx >= 0 ? currentIdx : 0];
  const futureLevels = activeLevels.slice((currentIdx >= 0 ? currentIdx : 0) + 1);

  const currentPkgs   = currentLevel?.children ?? [];
  const busy          = currentPkgs.filter(p => p.status !== 'pending');
  const queued        = currentPkgs.filter(p => p.status === 'pending');
  const visibleQueued = queued.slice(0, QUEUE_VISIBLE);
  const hiddenCount   = queued.length - QUEUE_VISIBLE;
  const futureCount   = futureLevels.reduce((n, l) => n + l.children.length, 0);

  return (
    <Box flexDirection="column">
      {/* Header + completed packages — flushed together in order */}
      <Static items={staticItems}>
        {item => {
          if (item.kind === 'header') {
            return (
              <Box key="__header__" flexDirection="column" width={termWidth} marginTop={2}>
                <Box justifyContent="space-between">
                  <Text dimColor>{item.totalPackages} packages · {item.totalLevels} levels</Text>
                  <Box gap={1}>
                    <Box width={COL_STATUS}><Text dimColor>status</Text></Box>
                    <Box width={COL_TIME}><Text dimColor>time</Text></Box>
                  </Box>
                </Box>
                <Divider />
              </Box>
            );
          }
          return <PackageRow key={item.node.id} props={toRowProps(item.node)} width={termWidth} />;
        }}
      </Static>

      {/* Active packages (dynamic — refreshes every render) */}
      {busy.map(pkg => <PackageRow key={pkg.id} props={toRowProps(pkg)} width={termWidth} />)}

      {visibleQueued.map(pkg => <PackageRow key={pkg.id} props={toRowProps(pkg)} width={termWidth} />)}
      {hiddenCount > 0 && (
        <Box marginLeft={2}>
          <Text dimColor>⋯ {hiddenCount} more queued</Text>
        </Box>
      )}

      {futureLevels.length > 0 && futureCount > 0 && (
        <Box marginLeft={2} marginTop={1}>
          <Text dimColor>
            {futureLevels.length === 1
              ? `Level ${doneLevels.length + (currentIdx >= 0 ? currentIdx : 0) + 1} — ${futureCount} waiting`
              : `${futureLevels.length} levels — ${futureCount} packages waiting`}
          </Text>
        </Box>
      )}
    </Box>
  );
}
