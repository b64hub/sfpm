import {Box, Text} from 'ink';

import type {AppState} from '../state/types.js';
import type {PackageCounts} from '../state/selectors.js';

import {countPackages} from '../state/selectors.js';
import {rawSym} from '../renderer-utils.js';

export function Footer({levels, phase}: {levels: AppState['levels']; phase: AppState['phase']}) {
  const counts: PackageCounts = countPackages(levels);
  return (
    <Box gap={2} marginTop={1}>
      <Text dimColor>{phase}</Text>
      <Text color="green">{counts.success} {rawSym.success}</Text>
      {counts.failed > 0 && <Text color="red">{counts.failed} {rawSym.fail}</Text>}
      {counts.running > 0 && <Text color="yellow">{counts.running} {rawSym.progress}</Text>}
      {counts.pending > 0 && <Text dimColor>{counts.pending} {rawSym.pending}</Text>}
    </Box>
  );
}
