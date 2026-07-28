import {Box, Static, Text} from 'ink';

import type {TreeNode} from '../state/types.js';

import {deriveStatus, toPackageRowProps} from '../state/selectors.js';
import {Divider} from './Divider.js';
import {COL_STATUS, COL_TIME, PackageRow} from './PackageRow.js';

const TERMINAL = new Set(['success', 'failed', 'skipped']);

/**
 * Max pending packages shown inside the currently-active level before
 * truncating with "⋯ N more waiting".
 */
const CURRENT_LEVEL_QUEUE_VISIBLE = 3;

export function OrchestrationView({levels}: {levels: TreeNode[]}) {
  const totalPackages = levels.reduce((n, l) => n + l.children.length, 0);

  // Completed levels — flushed to Static scroll buffer (append-only as levels finish)
  const doneLevels   = levels.filter(l => TERMINAL.has(deriveStatus(l.children)));
  const activeLevels = levels.filter(l => !TERMINAL.has(deriveStatus(l.children)));

  const donePackages = doneLevels.flatMap(l => l.children);

  // The "current" level is the first active one that has any running or failed packages.
  // Subsequent active levels are future levels — their packages are blocked and shown only as a summary.
  const currentLevelIdx = activeLevels.findIndex(l =>
    l.children.some(p => p.status === 'running' || p.status === 'failed'),
  );
  const currentLevel  = activeLevels[currentLevelIdx >= 0 ? currentLevelIdx : 0];
  const futureLevels  = activeLevels.slice((currentLevelIdx >= 0 ? currentLevelIdx : 0) + 1);

  // Within the current level: show busy (running/failed) always, truncate pending
  const currentPkgs   = currentLevel?.children ?? [];
  const busy          = currentPkgs.filter(p => p.status !== 'pending');
  const queued        = currentPkgs.filter(p => p.status === 'pending');
  const visibleQueued = queued.slice(0, CURRENT_LEVEL_QUEUE_VISIBLE);
  const hiddenCurrent = queued.length - CURRENT_LEVEL_QUEUE_VISIBLE;

  // Future levels shown as a single summary line each
  const futurePackageCount = futureLevels.reduce((n, l) => n + l.children.length, 0);

  return (
    <Box flexDirection="column">
      {/* Summary header */}
      <Box>
        <Box flexGrow={1}>
          <Text dimColor>{totalPackages} packages · {levels.length} levels</Text>
        </Box>
        <Box width={COL_STATUS}><Text dimColor>status</Text></Box>
        <Box width={COL_TIME}><Text dimColor>time</Text></Box>
      </Box>

      <Divider />

      {/* Completed packages — flushed to scroll history once a level finishes */}
      <Static items={donePackages}>
        {pkg => <PackageRow key={pkg.id} props={toPackageRowProps(pkg)} />}
      </Static>

      {/* Current-level: busy first, then visible queued */}
      {busy.map(pkg => <PackageRow key={pkg.id} props={toPackageRowProps(pkg)} />)}
      {visibleQueued.map(pkg => <PackageRow key={pkg.id} props={toPackageRowProps(pkg)} />)}
      {hiddenCurrent > 0 && (
        <Box marginLeft={2}>
          <Text dimColor>⋯ {hiddenCurrent} more queued</Text>
        </Box>
      )}

      {/* Future levels — one summary line each */}
      {futureLevels.length > 0 && futurePackageCount > 0 && (
        <Box marginLeft={2} marginTop={1}>
          <Text dimColor>
            {futureLevels.length === 1
              ? `Level ${doneLevels.length + (currentLevelIdx >= 0 ? currentLevelIdx : 0) + 1} — ${futurePackageCount} waiting`
              : `${futureLevels.length} levels — ${futurePackageCount} packages waiting`}
          </Text>
        </Box>
      )}
    </Box>
  );
}
